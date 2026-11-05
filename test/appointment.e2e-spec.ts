import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { MentorProfile, MentorTimeSlot, SyncPerson } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { buildDocument, configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { runWithSyncWrite } from '../src/infra/prisma/sync-write-scope';
import { ErrorCode } from '../src/common/constants/error-code';
import type { FieldErrorDto } from '../src/common/dto/field-error.dto';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import type { PermissionResponseDto } from '../src/modules/permission/dto/permission-response.dto';
import type { RoleResponseDto } from '../src/modules/role/dto/role-response.dto';
import type { AppointmentResponseDto } from '../src/modules/appointment/dto/appointment-response.dto';
import { NON_TERMINAL_APPOINTMENT_STATUSES } from '../src/modules/appointment/dto/create-appointment.dto';
import {
  authedAgent,
  clearBusinessTables,
  clearModuleTables,
  clearRedisKeys,
  loginAs,
  seedSuperAdmin,
  seedUser,
  type E2eApi,
} from './e2e-helpers';

const SYNCED_AT = new Date('2026-10-27T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 发起预约（学生）(e2e) —— Task 23 的全部判据。
 *
 * 共享库态、`maxWorkers: 1` 串行，**执行顺序即判据顺序**（前面的用例给后面造库态）：
 * - 学生 S001 / S002 / S003（带 `appointment:create`）、导师 T001（同码，用于「不是学生」）、
 *   无 SyncPerson 的 `no-person`、无权限码的 `no-perm`；
 * - 已生效导师 mentor-a / mentor-b，在审 mentor-pending，人员已离场的 mentor-gone；
 * - mentor-a 的周一 / 周二开放时段、周四关闭时段；mentor-b 的周五开放时段与
 *   「周一 09:00-11:00」（R31 时区判据专用，避开 SLOT_MON 的占用）。
 *
 * **时段是墙钟时间（R31）**：`weekday` / `HH:mm` 按 `Asia/Shanghai` 解释，
 * 造数助手 `futureAt` 按北京时间算，`utcAt` 只用于钉死「按 UTC 比较」的反例。
 *
 * docs:gen 的 56 路径 / 75 操作由门槛命令核；这里只钉预约面的路由形状
 * （Task 24 后为 4 条路径 / 4 个操作，Task 25 加取消后为 5 / 5）。
 */
describe('发起预约（学生）(e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;

  let adminApi: E2eApi;
  const agents = new Map<string, E2eApi>();
  const permissionIds = new Map<string, string>();
  const deptIds = new Map<string, bigint>();
  const people = new Map<string, SyncPerson>();
  const profiles = new Map<string, MentorProfile>();
  const slots = new Map<string, MentorTimeSlot>();

  /** 周一 09:00-11:00（mentor-a）——正例 / 守卫 5 占用 */
  const SLOT_MON = 'mon';
  /** 周二 09:00-11:00（mentor-a）——守卫 6 / 并发 */
  const SLOT_TUE = 'tue';
  /** 周四 09:00-11:00，status=0（mentor-a）——守卫 3 关闭时段 */
  const SLOT_CLOSED = 'closed';
  /** 周五 09:00-11:00（mentor-b）——守卫 3 不属于该导师 */
  const SLOT_B = 'b';
  /** 周一 09:00-11:00（mentor-b）——R31 时区判据专用（避开 SLOT_MON 的占用） */
  const SLOT_MON_B = 'mon-b';
  /** 周三 09:00-11:00（mentor-a）——守卫 ⑥ 并发判据的两个不同时段之一 */
  const SLOT_WED_A = 'wed-a';
  /** 周六 09:00-11:00（mentor-a）——守卫 ⑥ 并发判据的另一个时段 */
  const SLOT_SAT_A = 'sat-a';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);

    await clearBusinessTables(prisma);
    await clearAppointmentAndSyncTables(prisma);
    await clearModuleTables(prisma);
    await clearRedisKeys(redis);

    const admin = await seedSuperAdmin(prisma);
    const adminTokens = await loginAs(app, admin.username, admin.password);
    adminApi = authedAgent(app, adminTokens.accessToken);

    const rootDept = await prisma.client.sysDept.findFirst({
      where: { name: '总公司' },
    });
    if (rootDept === null) {
      throw new Error('seedSuperAdmin 未种出「总公司」部门');
    }
    deptIds.set('root', rootDept.id);
    deptIds.set('A', await createDept('学院 A', rootDept.id));
    deptIds.set('B', await createDept('学院 B', rootDept.id));

    const orgA = await createOrg('ORG-APPT-A', '学院 A 组织', dept('A'));
    const orgB = await createOrg('ORG-APPT-B', '学院 B 组织', dept('B'));

    // 同步层的行只有同步任务能写（SYNC_WRITE_FORBIDDEN）：测试造数走 runWithSyncWrite
    const identities: Array<[string, string, bigint]> = [
      ['S001', 'student', orgA],
      ['S002', 'student', orgA],
      ['S003', 'student', orgA],
      ['mentor-a', 'internalMentor', orgA],
      ['mentor-b', 'internalMentor', orgB],
      ['mentor-pending', 'internalMentor', orgA],
      ['mentor-gone', 'internalMentor', orgA],
      ['T001', 'internalMentor', orgA],
    ];
    for (const [login, personType, orgUnitId] of identities) {
      const person = await runWithSyncWrite(() =>
        prisma.client.syncPerson.create({
          data: {
            login,
            realName: login,
            personType,
            orgUnitId,
            syncedAt: SYNCED_AT,
            createdBy: 0n,
            updatedBy: 0n,
          },
        }),
      );
      people.set(login, person);
    }

    const studentRole = await createRoleWithCodes(
      '预约学生角色',
      'appt_student',
      'self',
      ['appointment:create'],
    );
    const mentorRole = await createRoleWithCodes(
      '预约导师角色',
      'appt_mentor',
      'self',
      ['appointment:create'],
    );
    const noPermRole = await createRoleWithCodes(
      '无预约权限角色',
      'no_appt',
      'self',
      [],
    );

    // username = login：身份链（SysUser.username → SyncPerson.login）靠自然键
    const users: Array<[string, bigint, RoleResponseDto]> = [
      ['S001', dept('A'), studentRole],
      ['S002', dept('A'), studentRole],
      ['S003', dept('A'), studentRole],
      ['T001', dept('A'), mentorRole],
      // 有权限码但配不上 SyncPerson：守卫 1「无 SyncPerson」那条
      ['no-person', dept('A'), studentRole],
      ['no-perm', dept('A'), noPermRole],
    ];
    for (const [username, deptId, role] of users) {
      const user = await seedUser(prisma, { username, deptId });
      await linkUserRole(user.userId, BigInt(role.id));
    }

    for (const login of [
      'S001',
      'S002',
      'S003',
      'T001',
      'no-person',
      'no-perm',
    ]) {
      const tokens = await loginAs(app, login, 'Passw0rd!');
      agents.set(login, authedAgent(app, tokens.accessToken));
    }

    // 四份档案：mentor-a / mentor-b / mentor-gone 已生效，mentor-pending 在审
    for (const [login, status] of [
      ['mentor-a', 2],
      ['mentor-b', 2],
      ['mentor-gone', 2],
      ['mentor-pending', 1],
    ] as const) {
      const profile = await prisma.client.mentorProfile.create({
        data: {
          personId: personId(login),
          researchFields: [],
          status,
          createdBy: 0n,
          updatedBy: 0n,
        },
      });
      profiles.set(login, profile);
    }

    // mentor-gone：档案仍在，但人员已离场（软删 SyncPerson）——守卫 2 的「人员已软删」
    const gone = people.get('mentor-gone');
    if (gone === undefined) {
      throw new Error('缺少 mentor-gone 的 SyncPerson');
    }
    await runWithSyncWrite(() =>
      prisma.includingDeleted.syncPerson.update({
        where: { id: gone.id },
        data: { deletedAt: new Date(), deletedBy: 0n },
      }),
    );

    slots.set(SLOT_MON, await createSlot(profileOf('mentor-a'), 1, 1));
    slots.set(SLOT_TUE, await createSlot(profileOf('mentor-a'), 2, 1));
    slots.set(SLOT_CLOSED, await createSlot(profileOf('mentor-a'), 4, 0));
    slots.set(SLOT_B, await createSlot(profileOf('mentor-b'), 5, 1));
    slots.set(SLOT_MON_B, await createSlot(profileOf('mentor-b'), 1, 1));
    slots.set(SLOT_WED_A, await createSlot(profileOf('mentor-a'), 3, 1));
    slots.set(SLOT_SAT_A, await createSlot(profileOf('mentor-a'), 6, 1));
  });

  afterAll(async () => {
    try {
      if (prisma !== undefined) {
        await clearAppointmentAndSyncTables(prisma);
        await clearBusinessTables(prisma);
        await clearModuleTables(prisma);
      }
      if (redis !== undefined) {
        await clearRedisKeys(redis);
      }
    } finally {
      if (app !== undefined) {
        await app.close();
      }
    }
  });

  // ── 造数助手 ──────────────────────────────────────────────────────

  function dept(key: string): bigint {
    const id = deptIds.get(key);
    if (id === undefined) {
      throw new Error(`没有 ${key} 部门`);
    }
    return id;
  }

  function personId(login: string): bigint {
    const person = people.get(login);
    if (person === undefined) {
      throw new Error(`没有 ${login} 的 SyncPerson`);
    }
    return person.id;
  }

  function profileOf(login: string): MentorProfile {
    const profile = profiles.get(login);
    if (profile === undefined) {
      throw new Error(`没有 ${login} 的导师档案`);
    }
    return profile;
  }

  function slotId(key: string): string {
    const slot = slots.get(key);
    if (slot === undefined) {
      throw new Error(`没有 ${key} 时段`);
    }
    return slot.id.toString();
  }

  function api(login: string): E2eApi {
    const agent = agents.get(login);
    if (agent === undefined) {
      throw new Error(`没有 ${login} 的登录态`);
    }
    return agent;
  }

  async function createDept(name: string, parentId: bigint): Promise<bigint> {
    const row = await prisma.client.sysDept.create({
      data: {
        parentId,
        name,
        sortOrder: 0,
        status: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    return row.id;
  }

  async function createOrg(
    code: string,
    name: string,
    deptId: bigint,
  ): Promise<bigint> {
    const row = await runWithSyncWrite(() =>
      prisma.client.syncOrgUnit.create({
        data: {
          code,
          name,
          kind: 'college',
          deptId,
          syncedAt: SYNCED_AT,
          createdBy: 0n,
          updatedBy: 0n,
        },
      }),
    );
    return row.id;
  }

  async function createSlot(
    profile: MentorProfile,
    weekday: number,
    status: number,
  ): Promise<MentorTimeSlot> {
    return prisma.client.mentorTimeSlot.create({
      data: {
        mentorProfileId: profile.id,
        weekday,
        startTime: '09:00',
        endTime: '11:00',
        status,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
  }

  async function ensurePermissionId(code: string): Promise<string> {
    const cached = permissionIds.get(code);
    if (cached !== undefined) {
      return cached;
    }
    const response = await adminApi
      .post('/permissions')
      .send({ type: 'BUTTON', code, name: `探针权限 ${code}` })
      .expect(201);
    const id = (response.body as ResponseEnvelope<PermissionResponseDto>).data
      .id;
    permissionIds.set(code, id);
    return id;
  }

  async function createRoleWithCodes(
    name: string,
    code: string,
    dataScope: string,
    codes: string[],
  ): Promise<RoleResponseDto> {
    const response = await adminApi
      .post('/roles')
      .send({ name, code, dataScope })
      .expect(201);
    const role = (response.body as ResponseEnvelope<RoleResponseDto>).data;
    const permIds: string[] = [];
    for (const permCode of codes) {
      permIds.push(await ensurePermissionId(permCode));
    }
    await adminApi
      .put(`/roles/${role.id}/permissions`)
      .send({ permissionIds: permIds })
      .expect(200);
    return role;
  }

  async function linkUserRole(userId: bigint, roleId: bigint): Promise<void> {
    await prisma.client.sysUserRole.create({
      data: { userId, roleId, createdBy: 0n, updatedBy: 0n },
    });
  }

  /** Asia/Shanghai 全年无夏令时，固定 +08:00 */
  const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

  /**
   * 未来最近一次「**北京时间** weekday 的 HH:mm」对应的 UTC 时刻，留 60 秒余量。
   *
   * R31：时段的 `weekday` / `HH:mm` 是墙钟时间（默认 Asia/Shanghai），所以造数
   * 也要按北京时间算，再把瞬时值交给服务端。`futureAt(1, '10:00')` 得到的是
   * 北京时间周一 10:00 = `02:00Z`。
   */
  function futureAt(weekday: number, timeOfDay: string): Date {
    const [hours, minutes] = timeOfDay.split(':').map(Number);
    const now = new Date();
    // 北京时间「今天」的年月日
    const beijingNow = new Date(now.getTime() + BEIJING_OFFSET_MS);
    // 北京时间今天 HH:mm 对应的 UTC 毫秒
    const baseMs =
      Date.UTC(
        beijingNow.getUTCFullYear(),
        beijingNow.getUTCMonth(),
        beijingNow.getUTCDate(),
        hours,
        minutes,
        0,
        0,
      ) - BEIJING_OFFSET_MS;

    for (let i = 0; i < 21; i += 1) {
      const candidateMs = baseMs + i * DAY_MS;
      const beijing = new Date(candidateMs + BEIJING_OFFSET_MS);
      const wd = beijing.getUTCDay() === 0 ? 7 : beijing.getUTCDay();
      if (wd === weekday && candidateMs > Date.now() + 60_000) {
        return new Date(candidateMs);
      }
    }
    throw new Error(`找不到未来的 weekday=${weekday} ${timeOfDay}`);
  }

  /**
   * 未来最近一次「**UTC** weekday 的 HH:mm」。
   *
   * 只给 R31 的反例用：同一个 UTC 时刻在北京时间是 17:00，用来钉死「按 UTC
   * 比较」这个错误（旧实现会把它当成合法时段）。
   */
  function utcAt(weekday: number, timeOfDay: string): Date {
    const [hours, minutes] = timeOfDay.split(':').map(Number);
    const now = new Date();
    const base = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        hours,
        minutes,
        0,
        0,
      ),
    );
    for (let i = 0; i < 21; i += 1) {
      const candidate = new Date(base.getTime() + i * DAY_MS);
      const wd = candidate.getUTCDay() === 0 ? 7 : candidate.getUTCDay();
      if (wd === weekday && candidate.getTime() > Date.now() + 60_000) {
        return candidate;
      }
    }
    throw new Error(`找不到未来的 UTC weekday=${weekday} ${timeOfDay}`);
  }

  function body(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      mentorProfileId: profileOf('mentor-a').id.toString(),
      type: 1,
      slotId: slotId(SLOT_MON),
      requestedTime: futureAt(1, '10:00').toISOString(),
      topic: '挑战杯选题与打磨',
      questions: '如何把技术方案讲成一个好故事？',
      mode: 1,
      ...overrides,
    };
  }

  function expectFieldError(response: { body: unknown }, field: string): void {
    const data = response.body as ResponseEnvelope<{ fields: FieldErrorDto[] }>;
    expect(data.code).toBe(ErrorCode.PARAM_INVALID);
    expect(data.data.fields.some((f) => f.field === field)).toBe(true);
  }

  // ── 判据 1：正例 201 + 落库 ─────────────────────────────────────

  it('判据 1：S001 发起周一 10:00 预约 → 201，status=0，七个字段原样落库', async () => {
    const requestedTime = futureAt(1, '10:00');
    const response = await api('S001')
      .post('/appointments')
      .send(
        body({
          type: 1,
          slotId: slotId(SLOT_MON),
          requestedTime: requestedTime.toISOString(),
          topic: '挑战杯选题与打磨',
          questions: '如何把技术方案讲成一个好故事？',
          mode: 1,
        }),
      )
      .expect(201);

    const data = (response.body as ResponseEnvelope<AppointmentResponseDto>)
      .data;
    expect(data).toMatchObject({
      studentPersonId: personId('S001').toString(),
      mentorProfileId: profileOf('mentor-a').id.toString(),
      type: 1,
      status: 0,
      requestedTime: requestedTime.toISOString(),
      proposedTime: null,
      topic: '挑战杯选题与打磨',
      questions: '如何把技术方案讲成一个好故事？',
      mode: 1,
      handleComment: null,
      rejectReason: null,
      slotId: slotId(SLOT_MON),
    });
    expect(data.id).toMatch(/^\d+$/);

    const row = await prisma.client.appointment.findFirst({
      where: { id: BigInt(data.id) },
    });
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      studentPersonId: personId('S001'),
      mentorProfileId: profileOf('mentor-a').id,
      type: 1,
      status: 0,
      topic: '挑战杯选题与打磨',
      questions: '如何把技术方案讲成一个好故事？',
      mode: 1,
      slotId: slots.get(SLOT_MON)?.id,
      proposedTime: null,
      handleComment: null,
      rejectReason: null,
    });
    expect(row?.requestedTime.toISOString()).toBe(requestedTime.toISOString());
  });

  // ── 判据 2：守卫 1（不是学生）────────────────────────────────────

  it('判据 2：导师 T001（有码）→ 403 / 10003「只有学生可以发起预约」', async () => {
    const response = await api('T001')
      .post('/appointments')
      .send(body({ slotId: slotId(SLOT_TUE) }))
      .expect(403);
    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.FORBIDDEN);
    expect(data.message).toBe('只有学生可以发起预约');
  });

  it('判据 2b：有码但无 SyncPerson → 403 / 10003', async () => {
    const response = await api('no-person')
      .post('/appointments')
      .send(body({ slotId: slotId(SLOT_TUE) }))
      .expect(403);
    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.FORBIDDEN);
    expect(data.message).toBe('只有学生可以发起预约');
  });

  it('判据 2c：无 appointment:create → 403，消息含该码', async () => {
    const response = await api('no-perm')
      .post('/appointments')
      .send(body({ slotId: slotId(SLOT_TUE) }))
      .expect(403);
    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.FORBIDDEN);
    expect(data.message).toContain('appointment:create');
  });

  // ── 判据 3：守卫 2（导师档案）────────────────────────────────────

  it('判据 3：未生效导师档案 → 404 / 31102', async () => {
    const response = await api('S002')
      .post('/appointments')
      .send(
        body({
          mentorProfileId: profileOf('mentor-pending').id.toString(),
          slotId: slotId(SLOT_TUE),
        }),
      )
      .expect(404);
    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.MENTOR_PROFILE_NOT_FOUND);
    expect(data.message).toBe('导师专业档案不存在');
  });

  it('判据 3b：导师档案不存在 → 404 / 31102', async () => {
    const response = await api('S002')
      .post('/appointments')
      .send(body({ mentorProfileId: '999999', slotId: slotId(SLOT_TUE) }))
      .expect(404);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.MENTOR_PROFILE_NOT_FOUND,
    );
  });

  it('判据 3c：人员已离场（SyncPerson 软删）→ 404 / 31102', async () => {
    const response = await api('S002')
      .post('/appointments')
      .send(
        body({
          mentorProfileId: profileOf('mentor-gone').id.toString(),
          slotId: slotId(SLOT_TUE),
        }),
      )
      .expect(404);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.MENTOR_PROFILE_NOT_FOUND,
    );
  });

  it('判据 3d：守卫顺序——第 2 条命中时不会走到第 3 条（坏 slotId 也是 31102）', async () => {
    const response = await api('S002')
      .post('/appointments')
      .send(
        body({
          mentorProfileId: profileOf('mentor-pending').id.toString(),
          slotId: '999999',
        }),
      )
      .expect(404);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.MENTOR_PROFILE_NOT_FOUND,
    );
  });

  // ── 判据 4：守卫 3（时段归属 / 关闭）──────────────────────────────

  it('判据 4：slotId 不存在 → 409 / 31202', async () => {
    const response = await api('S002')
      .post('/appointments')
      .send(body({ slotId: '999999' }))
      .expect(409);
    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.MENTOR_SLOT_UNAVAILABLE);
    expect(data.message).toBe('可指导时段不可用');
  });

  it('判据 4b：时段不属于该导师 → 409 / 31202', async () => {
    const response = await api('S002')
      .post('/appointments')
      .send(body({ slotId: slotId(SLOT_B) }))
      .expect(409);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.MENTOR_SLOT_UNAVAILABLE,
    );
  });

  it('判据 4c：时段已关闭（status=0）→ 409 / 31202', async () => {
    const response = await api('S002')
      .post('/appointments')
      .send(
        body({
          slotId: slotId(SLOT_CLOSED),
          requestedTime: futureAt(4, '10:00').toISOString(),
        }),
      )
      .expect(409);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.MENTOR_SLOT_UNAVAILABLE,
    );
  });

  // ── 判据 5：守卫 4（requestedTime 与时段不匹配）────────────────────

  it('判据 5：weekday 与时段不符 → 409 / 31202', async () => {
    const response = await api('S002')
      .post('/appointments')
      .send(
        body({
          slotId: slotId(SLOT_TUE),
          requestedTime: futureAt(1, '10:00').toISOString(),
        }),
      )
      .expect(409);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.MENTOR_SLOT_UNAVAILABLE,
    );
  });

  it('判据 5b：时刻不在 [09:00, 11:00) → 409 / 31202', async () => {
    const response = await api('S002')
      .post('/appointments')
      .send(
        body({
          slotId: slotId(SLOT_TUE),
          requestedTime: futureAt(2, '08:00').toISOString(),
        }),
      )
      .expect(409);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.MENTOR_SLOT_UNAVAILABLE,
    );
  });

  // ── 判据 6：守卫 5（时段被占用）──────────────────────────────────

  it('判据 6：周一 10:00 已被 S001 占用，S002 再抢 → 409 / 32004', async () => {
    const response = await api('S002')
      .post('/appointments')
      .send(
        body({
          slotId: slotId(SLOT_MON),
          requestedTime: futureAt(1, '10:00').toISOString(),
        }),
      )
      .expect(409);
    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.APPOINTMENT_SLOT_CONFLICT);
    expect(data.message).toBe('该时段已被预约占用');
  });

  // ── 判据 7：守卫 6（同学生同导师重复）──────────────────────────────

  it('判据 7：S001 对 mentor-a 已有未终态预约，换周二再约 → 409 / 32003', async () => {
    const response = await api('S001')
      .post('/appointments')
      .send(
        body({
          slotId: slotId(SLOT_TUE),
          requestedTime: futureAt(2, '10:00').toISOString(),
        }),
      )
      .expect(409);
    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.APPOINTMENT_TRANSITION_INVALID);
    expect(data.message).toBe('已有未完成的预约，不能重复发起');
  });

  // ── 判据 8：字段校验 ─────────────────────────────────────────────

  it('判据 8：type 传 0 / 6 / "x" → 各 400 / 10001，点名 type', async () => {
    for (const type of [0, 6, 'x']) {
      const response = await api('S003')
        .post('/appointments')
        .send(body({ type, slotId: slotId(SLOT_TUE) }))
        .expect(400);
      expectFieldError(response, 'type');
    }
  });

  it('判据 8b：mode 传 0 / 3 → 各 400 / 10001，点名 mode', async () => {
    for (const mode of [0, 3]) {
      const response = await api('S003')
        .post('/appointments')
        .send(body({ mode, slotId: slotId(SLOT_TUE) }))
        .expect(400);
      expectFieldError(response, 'mode');
    }
  });

  it('判据 8c：requestedTime 是过去时间 → 400 / 10001，点名 requestedTime', async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const response = await api('S003')
      .post('/appointments')
      .send(body({ slotId: slotId(SLOT_TUE), requestedTime: past }))
      .expect(400);
    expectFieldError(response, 'requestedTime');
  });

  it('判据 8d：topic 201 字 → 400，点名 topic', async () => {
    const response = await api('S003')
      .post('/appointments')
      .send(body({ slotId: slotId(SLOT_TUE), topic: '题'.repeat(201) }))
      .expect(400);
    expectFieldError(response, 'topic');
  });

  it('判据 8e：questions 2001 字 → 400，点名 questions', async () => {
    const response = await api('S003')
      .post('/appointments')
      .send(body({ slotId: slotId(SLOT_TUE), questions: '问'.repeat(2001) }))
      .expect(400);
    expectFieldError(response, 'questions');
  });

  // ── 判据 8f / 8g：R31 时区口径 ──────────────────────────────────

  it('判据 8f（R31）：时段周一 09:00-11:00，requestedTime=北京时间周一 10:00 → 201', async () => {
    const requestedTime = futureAt(1, '10:00');
    const response = await api('S003')
      .post('/appointments')
      .send(
        body({
          mentorProfileId: profileOf('mentor-b').id.toString(),
          slotId: slotId(SLOT_MON_B),
          requestedTime: requestedTime.toISOString(),
        }),
      )
      .expect(201);

    const data = (response.body as ResponseEnvelope<AppointmentResponseDto>)
      .data;
    expect(data).toMatchObject({
      mentorProfileId: profileOf('mentor-b').id.toString(),
      slotId: slotId(SLOT_MON_B),
      status: 0,
      requestedTime: requestedTime.toISOString(),
    });
  });

  it('判据 8g（R31）：同一 UTC 时刻的「周一 17:00 北京时间」（09:00Z）→ 409 / 31202', async () => {
    // 09:00Z 在 UTC 口径下正好落在 [09:00, 11:00)——旧实现会放行。
    // 按墙钟时间算是北京 17:00，必须拒绝。这条钉死 R31。
    const response = await api('S003')
      .post('/appointments')
      .send(
        body({
          mentorProfileId: profileOf('mentor-b').id.toString(),
          slotId: slotId(SLOT_MON_B),
          requestedTime: utcAt(1, '09:00').toISOString(),
        }),
      )
      .expect(409);
    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.MENTOR_SLOT_UNAVAILABLE);
    expect(data.message).toBe('可指导时段不可用');
  });

  // ── 判据 8h / 8i：非契约类型一律 400 ─────────────────────────────

  it('判据 8h：type / mode 传布尔 true → 各 400 / 10001，点名对应字段', async () => {
    const typeResponse = await api('S003')
      .post('/appointments')
      .send(body({ type: true, slotId: slotId(SLOT_TUE) }))
      .expect(400);
    expectFieldError(typeResponse, 'type');

    const modeResponse = await api('S003')
      .post('/appointments')
      .send(body({ mode: true, slotId: slotId(SLOT_TUE) }))
      .expect(400);
    expectFieldError(modeResponse, 'mode');
  });

  it('判据 8i：requestedTime 传数字时间戳 → 400 / 10001，点名 requestedTime', async () => {
    const response = await api('S003')
      .post('/appointments')
      .send(body({ slotId: slotId(SLOT_TUE), requestedTime: Date.now() }))
      .expect(400);
    expectFieldError(response, 'requestedTime');
  });

  // ── 判据 9：路由形状 ─────────────────────────────────────────────

  it('判据 9：预约面恰好 19 条路径 / 23 个操作（docs:gen 总数由门槛命令核）', () => {
    const document = buildDocument(app);
    const paths = document.paths as Record<string, Record<string, unknown>>;
    const apptPaths = Object.keys(paths).filter((path) =>
      path.startsWith('/appointments'),
    );
    // Task 24 追加了三条处理路由，Task 25 追加取消；Task 26 追加记录填报 / 读取
    // （同一条路径上的 POST + GET）；Task 27 追加学生确认记录 / 提异议
    // （2 条路径，各 1 个 POST）；Task 28 追加异议复核 adjudicate（1 条 POST）；
    // Task 29 追加预约材料 / 过程材料（materials 的 POST + GET、
    // materials/{materialId} 的 DELETE、record/materials 的 POST、
    // record/materials/{materialId} 的 DELETE，4 条路径 / 5 个操作）；
    // Task 30 追加列表（GET /appointments，与 POST 同一条路径，只多 1 个操作）
    // 与详情（GET /appointments/{id}，新路径 + 新操作）；
    // P3 Task 34 追加评价（POST + GET /appointments/{id}/review，1 条路径 / 2 个操作）；
    // 导师端缺口补齐：材料 / 过程材料的 preview + download 再加 4 条路径 / 4 个操作；
    // 本面从 1 条变 19 条、23 个操作
    expect(apptPaths.sort()).toEqual([
      '/appointments',
      '/appointments/{id}',
      '/appointments/{id}/adjudicate',
      '/appointments/{id}/cancel',
      '/appointments/{id}/confirm',
      '/appointments/{id}/confirm-record',
      '/appointments/{id}/dispute',
      '/appointments/{id}/materials',
      '/appointments/{id}/materials/{materialId}',
      '/appointments/{id}/materials/{materialId}/download',
      '/appointments/{id}/materials/{materialId}/preview',
      '/appointments/{id}/record',
      '/appointments/{id}/record/materials',
      '/appointments/{id}/record/materials/{materialId}',
      '/appointments/{id}/record/materials/{materialId}/download',
      '/appointments/{id}/record/materials/{materialId}/preview',
      '/appointments/{id}/reject',
      '/appointments/{id}/reschedule',
      '/appointments/{id}/review',
    ]);
    const operations = apptPaths.reduce(
      (sum, path) =>
        sum +
        Object.keys(paths[path]).filter((key) =>
          ['get', 'post', 'put', 'delete', 'patch'].includes(key),
        ).length,
      0,
    );
    expect(operations).toBe(23);
  });

  // ── 判据 10：并发（3 轮）────────────────────────────────────────

  it('判据 10：同一时段双发 3 轮，每轮恰 1×201 + 1×409/32004，库内恰 1 行', async () => {
    const rounds: Array<{ statuses: number[]; codes: number[]; rows: number }> =
      [];

    for (let round = 0; round < 3; round += 1) {
      // 每轮清空预约，让两名学生都回到「无未终态预约」的起点
      await prisma.includingDeleted.appointment.deleteMany({});

      const requestedTime = futureAt(2, '10:00').toISOString();
      const payload = body({
        slotId: slotId(SLOT_TUE),
        requestedTime,
      });

      const [first, second] = await Promise.all([
        api('S001').post('/appointments').send(payload),
        api('S002').post('/appointments').send(payload),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      const codes = [first, second].map(
        (response) => (response.body as ResponseEnvelope<null>).code,
      );
      const rows = await prisma.client.appointment.count({
        where: { slotId: slots.get(SLOT_TUE)?.id },
      });

      rounds.push({ statuses, codes, rows });

      expect(statuses).toEqual([201, 409]);
      expect(codes).toContain(ErrorCode.APPOINTMENT_SLOT_CONFLICT);
      expect(rows).toBe(1);
    }

    // 三轮读数留痕（报告直接引用）
    console.log('并发三轮读数', JSON.stringify(rounds));
  });

  // ── 判据 11：守卫 ⑥ 的并发（同学生同导师、两个不同时段）──────────

  it('判据 11：同一学生同导师、两个不同时段并发 3 轮 → 每轮恰 1×201 + 1×409/32003，在途恰 1 行', async () => {
    const rounds: Array<{
      statuses: number[];
      codes: number[];
      inFlight: number;
    }> = [];

    for (let round = 0; round < 3; round += 1) {
      // 每轮清空预约，让 S002 对 mentor-a 回到「无未终态预约」的起点
      await prisma.includingDeleted.appointment.deleteMany({});

      // 两个**不同**时段：锁时段行时互不阻塞（旧实现的漏洞），锁导师行才串行化
      const wednesday = body({
        slotId: slotId(SLOT_WED_A),
        requestedTime: futureAt(3, '10:00').toISOString(),
      });
      const saturday = body({
        slotId: slotId(SLOT_SAT_A),
        requestedTime: futureAt(6, '10:00').toISOString(),
      });

      const [first, second] = await Promise.all([
        api('S002').post('/appointments').send(wednesday),
        api('S002').post('/appointments').send(saturday),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      const codes = [first, second].map(
        (response) => (response.body as ResponseEnvelope<null>).code,
      );
      const inFlight = await prisma.client.appointment.count({
        where: {
          studentPersonId: personId('S002'),
          mentorProfileId: profileOf('mentor-a').id,
          status: { in: [...NON_TERMINAL_APPOINTMENT_STATUSES] },
        },
      });

      rounds.push({ statuses, codes, inFlight });

      expect(statuses).toEqual([201, 409]);
      expect(codes).toContain(ErrorCode.APPOINTMENT_TRANSITION_INVALID);
      expect(inFlight).toBe(1);
    }

    // 三轮读数留痕（报告直接引用）
    console.log('守卫 ⑥ 并发三轮读数', JSON.stringify(rounds));
  });
});

/**
 * 清预约域 + 同步层的残留（照 mentor-slot.e2e-spec 的同名函数）。
 *
 * 走 `includingDeleted`（物理删除）而不是裸 SQL：实体表在 `client` 上的
 * delete 会被 R24 守卫拒掉，`includingDeleted` 才是清库的合法出口。
 * 同步表即使在 `includingDeleted` 上也受 `SYNC_WRITE_FORBIDDEN` 约束，
 * 故包一层 `runWithSyncWrite`（测试造数 / 清库，不是业务写）。
 * 顺序按外键拓扑序：预约域先于时段，时段先于档案，档案先于 sync_person / sync_org_unit。
 */
async function clearAppointmentAndSyncTables(
  prisma: PrismaService,
): Promise<void> {
  await prisma.includingDeleted.achievement.deleteMany({});
  await prisma.includingDeleted.assessmentAppeal.deleteMany({});
  await prisma.includingDeleted.assessment.deleteMany({});
  await prisma.includingDeleted.studentReview.deleteMany({});
  await prisma.includingDeleted.guidanceMaterial.deleteMany({});
  await prisma.includingDeleted.guidanceRecord.deleteMany({});
  await prisma.includingDeleted.appointmentMaterial.deleteMany({});
  await prisma.includingDeleted.appointment.deleteMany({});
  await prisma.includingDeleted.mentorTimeSlot.deleteMany({});
  await prisma.includingDeleted.mentorApplicationMaterial.deleteMany({});
  await prisma.includingDeleted.mentorApplication.deleteMany({});
  await prisma.includingDeleted.mentorProfile.deleteMany({});
  await runWithSyncWrite(() =>
    prisma.includingDeleted.syncPerson.deleteMany({}),
  );
  await runWithSyncWrite(() =>
    prisma.includingDeleted.syncOrgUnit.deleteMany({}),
  );
}
