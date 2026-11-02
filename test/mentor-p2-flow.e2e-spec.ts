import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { MentorProfile, SyncPerson } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { runWithSyncWrite } from '../src/infra/prisma/sync-write-scope';
import { ErrorCode } from '../src/common/constants/error-code';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import type { PermissionResponseDto } from '../src/modules/permission/dto/permission-response.dto';
import type { RoleResponseDto } from '../src/modules/role/dto/role-response.dto';
import type { SlotResponseDto } from '../src/modules/mentor-slot/dto/slot-response.dto';
import type { MentorSearchPageResponseDto } from '../src/modules/mentor-search/dto/query-mentor.dto';
import type { AppointmentResponseDto } from '../src/modules/appointment/dto/appointment-response.dto';
import type { AppointmentListResponseDto } from '../src/modules/appointment/dto/appointment-list.dto';
import type { GuidanceRecordResponseDto } from '../src/modules/appointment/dto/guidance-record-response.dto';
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
/** Asia/Shanghai 全年无夏令时，固定 +08:00 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

const ROLE_KEYS = ['mentor', 'student', 'college_admin', 'sc_admin'] as const;

type RoleKey = (typeof ROLE_KEYS)[number];

/** 角色 → 登录名（username = SyncPerson.login，身份链靠自然键） */
const ROLE_LOGIN: Readonly<Record<RoleKey, string>> = {
  mentor: 'mentor-a',
  student: 'student-1',
  college_admin: 'college-admin',
  sc_admin: 'sc-admin',
};

/** 矩阵的六个码（brief 表格的行） */
type MatrixCode =
  | 'mentor:slot-manage'
  | 'mentor:search'
  | 'appointment:create'
  | 'appointment:handle'
  | 'appointment:list'
  | 'appointment:adjudicate';

/**
 * 角色 → 码与 dataScope，逐格照抄 `prisma/seed.ts` 的 `SEED_ROLES` /
 * `SEED_ROLE_PERMISSIONS`（只取矩阵这六个码）：
 * - mentor：slot-manage / search / handle / list；
 * - student：search / create / list；
 * - college_admin：search / list / adjudicate（deptAndChildren）；
 * - sc_admin：search / list / adjudicate（all）。
 */
const ROLE_SPECS: Readonly<
  Record<
    RoleKey,
    { name: string; dataScope: string; codes: readonly MatrixCode[] }
  >
> = {
  mentor: {
    name: '导师',
    dataScope: 'self',
    codes: [
      'mentor:slot-manage',
      'mentor:search',
      'appointment:handle',
      'appointment:list',
    ],
  },
  student: {
    name: '学生',
    dataScope: 'self',
    codes: ['mentor:search', 'appointment:create', 'appointment:list'],
  },
  college_admin: {
    name: '二级学院管理员',
    dataScope: 'deptAndChildren',
    codes: ['mentor:search', 'appointment:list', 'appointment:adjudicate'],
  },
  sc_admin: {
    name: '双创学院管理员',
    dataScope: 'all',
    codes: ['mentor:search', 'appointment:list', 'appointment:adjudicate'],
  },
};

/** 一条待发请求（supertest 的 Test 是可 await 的） */
type HttpTest = ReturnType<E2eApi['get']>;

interface HttpResult {
  status: number;
  body: unknown;
}

interface MatrixRow {
  code: MatrixCode;
  /** 只列 ✅ 格；没列的角色即 ✗ 格 */
  allowed: Partial<Record<RoleKey, { status: number; code: number }>>;
  request: (agent: E2eApi) => HttpTest;
}

async function callHttp(request: HttpTest): Promise<HttpResult> {
  const response = await request;
  return { status: response.status, body: response.body as unknown };
}

/**
 * 清掉预约域的十二张表 + 同步层的两张表，按外键拓扑序。
 *
 * 搬自 appointment.e2e-spec.ts：实体表必须走 `includingDeleted`（走 client 会被
 * 扩展拒绝），同步层的表必须包在 `runWithSyncWrite` 里（否则 SYNC_WRITE_FORBIDDEN）。
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

/**
 * P2 端到端验收（Task 32）——三件事，一个套件：
 *
 * 1. **正链七步**：导师开放时段 → 学生检索 → 发起 → 确认 → 填记录 → 学生确认
 *    → 止步于 `4 STUDENT_CONFIRMED`（P3 的评价接在 4 之后，本任务只验状态停在 4）。
 * 2. **四条负路径**：拒绝后重新发起（7 → 新 0）、改期（仍在 0，`requestedTime`
 *    一字不动）、异议 + 复核 uphold（5 → 6，`disputeReason` 清空）、取消后终态
 *    不可逆（8 之后再操作 → 409 / 32003）。
 * 3. **权限矩阵 24 格**：6 个码 × 4 个角色，逐格一条用例。
 *
 * 矩阵的 ✗ 格**不是**只断言 `403 / 10003`——服务层自己也会吐 10003。按 brief 的
 * 两条规则把它做成真断言：
 * - 规则 1（选对路由）：`appointment:create` 走 `POST /appointments/:id/cancel`
 *   （有码时非本人 → 32002），`appointment:handle` 走
 *   `POST /appointments/:id/confirm`（有码时非该预约导师 → 32002），其余四行走
 *   各自模块的第一条路由。有码 / 无码返回**不同错误码**，删掉控制器上的
 *   `@RequirePermission` 用例才会转红。
 * - 规则 2（断言文案）：✗ 格还要断言 `message` 里出现 `缺少 <权限码>`——
 *   那是 `PermissionGuard` 的文案，服务层的「无权限」不含「缺少 …」。
 *
 * 反过来，✅ 格断言**精确的 (status, code)**，而不是「非 403/10003」：三个
 * 允许格里业务本身就会回 403/32002（学生取消别人的、导师确认别人的），
 * 「非 10003」这种宽松断言区分不出「闸放行了」和「闸挡住了但码不同」。
 *
 * 共享库态、`maxWorkers: 1` 串行，**执行顺序即判据顺序**：矩阵在前（此时
 * 「别人的预约」还是 `0 PENDING`，各格期望才稳定），正链与负路径在后，
 * 列表可见性最后（它数的是全量行）。
 */
describe('P2 端到端验收（正链 / 负路径 / 权限矩阵）(e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;

  let adminApi: E2eApi;
  const agents = new Map<string, E2eApi>();
  const permissionIds = new Map<string, string>();
  const roleIds = new Map<RoleKey, bigint>();
  const deptIds = new Map<string, bigint>();
  const people = new Map<string, SyncPerson>();
  const profiles = new Map<string, MentorProfile>();

  /** 正链那条预约（student-1 → mentor-a，一路走到 4） */
  let flowAppointmentId: bigint;
  /** 正链的时段（周一 09:00-11:00） */
  let flowSlotId: bigint;
  /** 负路径 N1 的第一次预约（被拒绝 → 7） */
  let n1FirstId: bigint;
  /** 负路径 N1 重新发起的那条（N2 改期、N3 异议 / 裁决都作用在它上面） */
  let n1SecondId: bigint;
  /** 「别人的预约」：student-2 → mentor-b，status=0。矩阵 ✗ 格与 N4 用它 */
  let foreignAppointmentId: bigint;

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

    const orgA = await createOrg('ORG-P2-A', '学院 A 组织', dept('A'));
    const orgB = await createOrg('ORG-P2-B', '学院 B 组织', dept('B'));

    // 同步层的行只有同步任务能写（SYNC_WRITE_FORBIDDEN）：造数走 runWithSyncWrite
    const identities: Array<[string, string, string, bigint]> = [
      ['mentor-a', '导师甲', 'internalMentor', orgA],
      ['mentor-b', '导师乙', 'internalMentor', orgB],
      ['student-1', '学生甲', 'student', orgA],
      ['student-2', '学生乙', 'student', orgA],
    ];
    for (const [login, realName, personType, orgUnitId] of identities) {
      const person = await runWithSyncWrite(() =>
        prisma.client.syncPerson.create({
          data: {
            login,
            realName,
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

    // 四个角色：码与 dataScope 逐格照抄 seed
    for (const role of ROLE_KEYS) {
      const spec = ROLE_SPECS[role];
      const created = await createRoleWithCodes(
        spec.name,
        role,
        spec.dataScope,
        spec.codes,
      );
      roleIds.set(role, BigInt(created.id));
    }

    // username = SyncPerson.login：身份链（SysUser.username → SyncPerson.login）
    const users: Array<[string, bigint, RoleKey]> = [
      ['mentor-a', dept('A'), 'mentor'],
      ['student-1', dept('A'), 'student'],
      ['student-2', dept('A'), 'student'],
      ['college-admin', dept('A'), 'college_admin'],
      ['sc-admin', dept('root'), 'sc_admin'],
    ];
    for (const [username, deptId, role] of users) {
      const user = await seedUser(prisma, { username, deptId });
      await linkUserRole(user.userId, roleId(role));
    }
    for (const [username] of users) {
      const tokens = await loginAs(app, username, 'Passw0rd!');
      agents.set(username, authedAgent(app, tokens.accessToken));
    }

    // 两份已生效导师档案（检索 / 预约都只认 status = 2）
    const profileSpecs: Array<[string, string, string]> = [
      ['mentor-a', '教授', '长期从事创新创业指导'],
      ['mentor-b', '副教授', '研究方向为智能制造'],
    ];
    for (const [login, title, summary] of profileSpecs) {
      const profile = await prisma.client.mentorProfile.create({
        data: {
          personId: personId(login),
          researchFields: ['创新创业'],
          status: 2,
          professionalTitle: title,
          summary,
          createdBy: 0n,
          updatedBy: 0n,
        },
      });
      profiles.set(login, profile);
    }

    // 「别人的预约」：student-2 约 mentor-b，status=0。不带时段（slotId 可为 null）
    const foreign = await prisma.client.appointment.create({
      data: {
        studentPersonId: personId('student-2'),
        mentorProfileId: profileOf('mentor-b').id,
        type: 2,
        status: 0,
        requestedTime: futureAt(5, '10:00'),
        topic: '矩阵探针用的他人预约',
        questions: '这条预约只用于权限矩阵与终态不可逆的判据',
        mode: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    foreignAppointmentId = foreign.id;
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

  function roleId(role: RoleKey): bigint {
    const id = roleIds.get(role);
    if (id === undefined) {
      throw new Error(`没有 ${role} 角色`);
    }
    return id;
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

  async function ensurePermissionId(code: string): Promise<string> {
    const cached = permissionIds.get(code);
    if (cached !== undefined) {
      return cached;
    }
    const response = await adminApi
      .post('/permissions')
      .send({ type: 'BUTTON', code, name: `P2 验收权限 ${code}` })
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
    codes: readonly string[],
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

  async function linkUserRole(userId: bigint, role: bigint): Promise<void> {
    await prisma.client.sysUserRole.create({
      data: { userId, roleId: role, createdBy: 0n, updatedBy: 0n },
    });
  }

  /**
   * 未来最近一次「**北京时间** weekday 的 HH:mm」对应的 UTC 时刻，留 60 秒余量。
   *
   * R31：时段的 `weekday` / `HH:mm` 是墙钟时间（默认 `Asia/Shanghai`），造数
   * 也要按北京时间算，再把瞬时值交给服务端。
   */
  function futureAt(weekday: number, timeOfDay: string): Date {
    const [hours, minutes] = timeOfDay.split(':').map(Number);
    const now = new Date();
    const beijingNow = new Date(now.getTime() + BEIJING_OFFSET_MS);
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

  function appointmentBody(input: {
    mentor: string;
    slotId: bigint;
    requestedTime: Date;
    topic: string;
  }): Record<string, unknown> {
    return {
      mentorProfileId: profileOf(input.mentor).id.toString(),
      type: 1,
      slotId: input.slotId.toString(),
      requestedTime: input.requestedTime.toISOString(),
      topic: input.topic,
      questions: '如何把技术方案讲成一个好故事？',
      mode: 1,
    };
  }

  async function listAs(login: string): Promise<AppointmentListResponseDto> {
    const response = await api(login).get('/appointments').expect(200);
    return (response.body as ResponseEnvelope<AppointmentListResponseDto>).data;
  }

  // ── 一、权限矩阵 24 格 ────────────────────────────────────────────

  /**
   * 矩阵行。`allowed` 只列 ✅ 格；没列的角色就是 ✗ 格。
   *
   * `request` 里的 `foreignAppointmentId` 在 `beforeAll` 才赋值，闭包在用例
   * 执行时才求值，所以这里可以安全地先建表。
   */
  const MATRIX: readonly MatrixRow[] = [
    {
      code: 'mentor:slot-manage',
      allowed: { mentor: { status: 200, code: 0 } },
      request: (agent) => agent.get('/mentor/slots'),
    },
    {
      code: 'mentor:search',
      allowed: {
        mentor: { status: 200, code: 0 },
        student: { status: 200, code: 0 },
        college_admin: { status: 200, code: 0 },
        sc_admin: { status: 200, code: 0 },
      },
      request: (agent) => agent.get('/mentors'),
    },
    {
      // 规则 1：有码时「不是申请人本人」→ 32002，无码时 → 10003
      code: 'appointment:create',
      allowed: {
        student: { status: 403, code: ErrorCode.APPOINTMENT_FORBIDDEN },
      },
      request: (agent) =>
        agent
          .post(`/appointments/${foreignAppointmentId.toString()}/cancel`)
          .send({}),
    },
    {
      // 规则 1：有码时「不是该预约的导师」→ 32002，无码时 → 10003
      code: 'appointment:handle',
      allowed: {
        mentor: { status: 403, code: ErrorCode.APPOINTMENT_FORBIDDEN },
      },
      request: (agent) =>
        agent
          .post(`/appointments/${foreignAppointmentId.toString()}/confirm`)
          .send({}),
    },
    {
      code: 'appointment:list',
      allowed: {
        mentor: { status: 200, code: 0 },
        student: { status: 200, code: 0 },
        college_admin: { status: 200, code: 0 },
        sc_admin: { status: 200, code: 0 },
      },
      request: (agent) => agent.get('/appointments'),
    },
    {
      // 两个管理员都过闸；数据范围覆盖申请人部门，卡在「状态不是 5」→ 32003
      code: 'appointment:adjudicate',
      allowed: {
        college_admin: {
          status: 409,
          code: ErrorCode.APPOINTMENT_TRANSITION_INVALID,
        },
        sc_admin: {
          status: 409,
          code: ErrorCode.APPOINTMENT_TRANSITION_INVALID,
        },
      },
      request: (agent) =>
        agent
          .post(`/appointments/${foreignAppointmentId.toString()}/adjudicate`)
          .send({ decision: 'uphold', comment: '矩阵探针：状态不是 5' }),
    },
  ];

  for (const row of MATRIX) {
    for (const role of ROLE_KEYS) {
      const allowed = row.allowed[role];
      const expectation =
        allowed === undefined
          ? '✗ 403 / 10003'
          : `✅ ${allowed.status} / ${allowed.code}`;
      it(`权限矩阵：${row.code} × ${role} → ${expectation}`, async () => {
        const response = await callHttp(row.request(api(ROLE_LOGIN[role])));
        const body = response.body as ResponseEnvelope<unknown>;

        if (allowed !== undefined) {
          // ✅ 格断言精确读数：业务自己的 403/32002 与权限闸的 403/10003 不同码
          expect({ status: response.status, code: body.code }).toEqual(allowed);
          return;
        }

        // ✗ 格：status + code + 文案三件套，缺一条就是空断言（规则 2）
        expect(response.status).toBe(403);
        expect(body.code).toBe(ErrorCode.FORBIDDEN);
        expect(body.message).toContain(`缺少 ${row.code}`);
      });
    }
  }

  // ── 二、正链七步 ──────────────────────────────────────────────────

  it('正链 1：导师开放周一 09:00-11:00 → 201，库里落 1 行 status=1', async () => {
    const response = await api('mentor-a')
      .post('/mentor/slots')
      .send({ weekday: 1, startTime: '09:00', endTime: '11:00' })
      .expect(201);

    const data = (response.body as ResponseEnvelope<SlotResponseDto>).data;
    flowSlotId = BigInt(data.id);
    expect(data).toMatchObject({
      mentorProfileId: profileOf('mentor-a').id.toString(),
      weekday: 1,
      startTime: '09:00',
      endTime: '11:00',
      status: 1,
    });

    const row = await prisma.client.mentorTimeSlot.findFirst({
      where: { id: flowSlotId },
    });
    if (row === null) {
      throw new Error('时段没有落库');
    }
    expect(row).toMatchObject({
      mentorProfileId: profileOf('mentor-a').id,
      weekday: 1,
      startTime: '09:00',
      endTime: '11:00',
      status: 1,
    });
  });

  it('正链 2：学生检索「导师甲」→ 200，只命中该导师档案', async () => {
    const response = await api('student-1')
      .get('/mentors')
      .query({ keyword: '导师甲' })
      .expect(200);

    const data = (
      response.body as ResponseEnvelope<MentorSearchPageResponseDto>
    ).data;
    expect(data.total).toBe(1);
    expect(data.list).toHaveLength(1);
    expect(data.list[0]).toMatchObject({
      id: profileOf('mentor-a').id.toString(),
      name: '导师甲',
      mentorType: 'internal',
      professionalTitle: '教授',
    });
  });

  it('正链 3：学生按该时段发起预约 → 201，status=0，requestedTime 原样落库', async () => {
    const requestedTime = futureAt(1, '10:00');
    const response = await api('student-1')
      .post('/appointments')
      .send(
        appointmentBody({
          mentor: 'mentor-a',
          slotId: flowSlotId,
          requestedTime,
          topic: '挑战杯项目选题与打磨',
        }),
      )
      .expect(201);

    const data = (response.body as ResponseEnvelope<AppointmentResponseDto>)
      .data;
    flowAppointmentId = BigInt(data.id);
    expect(data).toMatchObject({
      studentPersonId: personId('student-1').toString(),
      mentorProfileId: profileOf('mentor-a').id.toString(),
      status: 0,
      slotId: flowSlotId.toString(),
      requestedTime: requestedTime.toISOString(),
      proposedTime: null,
      topic: '挑战杯项目选题与打磨',
    });

    const row = await prisma.client.appointment.findFirst({
      where: { id: flowAppointmentId },
    });
    if (row === null) {
      throw new Error('预约没有落库');
    }
    expect(row.status).toBe(0);
    expect(row.studentPersonId).toBe(personId('student-1'));
    expect(row.requestedTime.toISOString()).toBe(requestedTime.toISOString());
  });

  it('正链 4：导师确认 → 1 CONFIRMED，handleComment 落库', async () => {
    const response = await api('mentor-a')
      .post(`/appointments/${flowAppointmentId.toString()}/confirm`)
      .send({ comment: '确认，周一上午见' })
      .expect(200);

    const data = (response.body as ResponseEnvelope<AppointmentResponseDto>)
      .data;
    expect(data).toMatchObject({
      id: flowAppointmentId.toString(),
      status: 1,
      handleComment: '确认，周一上午见',
    });

    const row = await prisma.client.appointment.findFirst({
      where: { id: flowAppointmentId },
    });
    expect(row?.status).toBe(1);
    expect(row?.handleComment).toBe('确认，周一上午见');
  });

  it('正链 5：导师提交指导记录 → 201，预约一步到 3 RECORD_SUBMITTED', async () => {
    const actualTime = new Date(Date.now() - 60_000);
    const response = await api('mentor-a')
      .post(`/appointments/${flowAppointmentId.toString()}/record`)
      .send({
        actualTime: actualTime.toISOString(),
        mode: 2,
        coreContent: '围绕挑战杯选题，梳理了三条可行技术路线并确定主攻方向。',
        followUp: '下次带原型演示，重点讲清数据来源与评测口径。',
      })
      .expect(201);

    const data = (response.body as ResponseEnvelope<GuidanceRecordResponseDto>)
      .data;
    expect(data).toMatchObject({
      appointmentId: flowAppointmentId.toString(),
      mode: 2,
      submittedBy: personId('mentor-a').toString(),
      actualTime: actualTime.toISOString(),
      coreContent: '围绕挑战杯选题，梳理了三条可行技术路线并确定主攻方向。',
      followUp: '下次带原型演示，重点讲清数据来源与评测口径。',
    });
    expect(data.submittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const appointment = await prisma.client.appointment.findFirst({
      where: { id: flowAppointmentId },
    });
    expect(appointment?.status).toBe(3);

    const record = await prisma.client.guidanceRecord.findFirst({
      where: { appointmentId: flowAppointmentId },
    });
    if (record === null) {
      throw new Error('指导记录没有落库');
    }
    expect(record.mode).toBe(2);
    expect(record.submittedBy).toBe(personId('mentor-a'));
  });

  it('正链 6：学生确认记录 → 4 STUDENT_CONFIRMED（不直接到 6）', async () => {
    const response = await api('student-1')
      .post(`/appointments/${flowAppointmentId.toString()}/confirm-record`)
      .send({})
      .expect(200);

    const data = (response.body as ResponseEnvelope<AppointmentResponseDto>)
      .data;
    expect(data).toMatchObject({
      id: flowAppointmentId.toString(),
      status: 4,
      disputeReason: null,
    });

    const row = await prisma.client.appointment.findFirst({
      where: { id: flowAppointmentId },
    });
    expect(row?.status).toBe(4);
  });

  it('正链 7：止步于 4——详情再读一次仍是 4，指导记录仍可读', async () => {
    const detail = await api('student-1')
      .get(`/appointments/${flowAppointmentId.toString()}`)
      .expect(200);
    const detailData = (detail.body as ResponseEnvelope<AppointmentResponseDto>)
      .data;
    expect(detailData.status).toBe(4);

    const record = await api('student-1')
      .get(`/appointments/${flowAppointmentId.toString()}/record`)
      .expect(200);
    const recordData = (
      record.body as ResponseEnvelope<GuidanceRecordResponseDto>
    ).data;
    expect(recordData.appointmentId).toBe(flowAppointmentId.toString());

    const row = await prisma.client.appointment.findFirst({
      where: { id: flowAppointmentId },
    });
    // P3 的评价接在 4 之后：本任务只验状态停在 4，不验 4 → 6
    expect(row?.status).toBe(4);
  });

  // ── 三、负路径 ────────────────────────────────────────────────────

  it('N1：导师拒绝（带原因）→ 7；学生重新发起 → 新预约 0，两条不同 id', async () => {
    // 周二时段：与正链的周一互不重叠
    const slotResponse = await api('mentor-a')
      .post('/mentor/slots')
      .send({ weekday: 2, startTime: '09:00', endTime: '11:00' })
      .expect(201);
    const n1SlotId = BigInt(
      (slotResponse.body as ResponseEnvelope<SlotResponseDto>).data.id,
    );

    const requestedTime = futureAt(2, '10:00');
    const first = await api('student-2')
      .post('/appointments')
      .send(
        appointmentBody({
          mentor: 'mentor-a',
          slotId: n1SlotId,
          requestedTime,
          topic: 'N1 第一次预约',
        }),
      )
      .expect(201);
    n1FirstId = BigInt(
      (first.body as ResponseEnvelope<AppointmentResponseDto>).data.id,
    );

    const rejected = await api('mentor-a')
      .post(`/appointments/${n1FirstId.toString()}/reject`)
      .send({ reason: '该时段已排满，请另约' })
      .expect(200);
    const rejectedData = (
      rejected.body as ResponseEnvelope<AppointmentResponseDto>
    ).data;
    expect(rejectedData.status).toBe(7);
    expect(rejectedData.rejectReason).toBe('该时段已排满，请另约');

    const rejectedRow = await prisma.client.appointment.findFirst({
      where: { id: n1FirstId },
    });
    expect(rejectedRow?.status).toBe(7);

    // 终态不再占用时段、不再阻断「同学生同导师」——重新发起必须是一条新行
    const second = await api('student-2')
      .post('/appointments')
      .send(
        appointmentBody({
          mentor: 'mentor-a',
          slotId: n1SlotId,
          requestedTime,
          topic: 'N1 重新发起',
        }),
      )
      .expect(201);
    const secondData = (second.body as ResponseEnvelope<AppointmentResponseDto>)
      .data;
    n1SecondId = BigInt(secondData.id);
    expect(n1SecondId).not.toBe(n1FirstId);
    expect(secondData.status).toBe(0);

    const rows = await prisma.client.appointment.findMany({
      where: { id: { in: [n1FirstId, n1SecondId] } },
    });
    expect(rows).toHaveLength(2);
  });

  it('N2：导师调整时间 → 仍在 0、proposedTime 变、requestedTime 一字不动', async () => {
    const before = await prisma.client.appointment.findFirst({
      where: { id: n1SecondId },
    });
    if (before === null) {
      throw new Error('N1 重新发起的预约不存在');
    }
    const beforeRequested = before.requestedTime.toISOString();

    const proposedTime = futureAt(3, '10:00');
    const response = await api('mentor-a')
      .post(`/appointments/${n1SecondId.toString()}/reschedule`)
      .send({
        proposedTime: proposedTime.toISOString(),
        comment: '周三上午更方便',
      })
      .expect(200);

    const data = (response.body as ResponseEnvelope<AppointmentResponseDto>)
      .data;
    expect(data.status).toBe(0);
    expect(data.proposedTime).toBe(proposedTime.toISOString());
    expect(data.requestedTime).toBe(beforeRequested);

    const after = await prisma.client.appointment.findFirst({
      where: { id: n1SecondId },
    });
    expect(after?.status).toBe(0);
    expect(after?.proposedTime?.toISOString()).toBe(proposedTime.toISOString());
    // R13：requestedTime 保留原值才能看出导师改了什么
    expect(after?.requestedTime.toISOString()).toBe(beforeRequested);
  });

  it('N3：学生异议 → 5 → 二级学院裁决 uphold → 6，disputeReason 被清空', async () => {
    await api('mentor-a')
      .post(`/appointments/${n1SecondId.toString()}/confirm`)
      .send({ comment: '确认' })
      .expect(200);

    const actualTime = new Date(Date.now() - 120_000);
    await api('mentor-a')
      .post(`/appointments/${n1SecondId.toString()}/record`)
      .send({
        actualTime: actualTime.toISOString(),
        mode: 1,
        coreContent: 'N3 的指导记录：确认了竞赛材料的修改清单。',
        followUp: '下次核对材料定稿。',
      })
      .expect(201);

    const disputed = await api('student-2')
      .post(`/appointments/${n1SecondId.toString()}/dispute`)
      .send({ reason: '记录中的指导方式与实际不符' })
      .expect(200);
    const disputedData = (
      disputed.body as ResponseEnvelope<AppointmentResponseDto>
    ).data;
    expect(disputedData.status).toBe(5);
    expect(disputedData.disputeReason).toBe('记录中的指导方式与实际不符');

    const disputedRow = await prisma.client.appointment.findFirst({
      where: { id: n1SecondId },
    });
    expect(disputedRow?.status).toBe(5);
    expect(disputedRow?.disputeReason).toBe('记录中的指导方式与实际不符');

    const adjudicated = await api('college-admin')
      .post(`/appointments/${n1SecondId.toString()}/adjudicate`)
      .send({ decision: 'uphold', comment: '经核对，异议成立' })
      .expect(200);
    const adjudicatedData = (
      adjudicated.body as ResponseEnvelope<AppointmentResponseDto>
    ).data;
    expect(adjudicatedData.status).toBe(6);
    expect(adjudicatedData.disputeReason).toBeNull();
    expect(adjudicatedData.adjudicateComment).toBe('经核对，异议成立');

    const row = await prisma.client.appointment.findFirst({
      where: { id: n1SecondId },
    });
    expect(row?.status).toBe(6);
    expect(row?.disputeReason).toBeNull();
    expect(row?.adjudicateComment).toBe('经核对，异议成立');
  });

  it('N4：学生取消 → 8；终态再操作 → 409 / 32003，库里仍是 8', async () => {
    const cancelled = await api('student-2')
      .post(`/appointments/${foreignAppointmentId.toString()}/cancel`)
      .send({})
      .expect(200);
    const cancelledData = (
      cancelled.body as ResponseEnvelope<AppointmentResponseDto>
    ).data;
    expect(cancelledData.status).toBe(8);

    const cancelledRow = await prisma.client.appointment.findFirst({
      where: { id: foreignAppointmentId },
    });
    expect(cancelledRow?.status).toBe(8);

    const again = await api('student-2')
      .post(`/appointments/${foreignAppointmentId.toString()}/cancel`)
      .send({})
      .expect(409);
    const againBody = again.body as ResponseEnvelope<null>;
    expect(againBody.code).toBe(ErrorCode.APPOINTMENT_TRANSITION_INVALID);
    expect(againBody.message).toBe('当前状态不允许该操作');

    const afterRow = await prisma.client.appointment.findFirst({
      where: { id: foreignAppointmentId },
    });
    // 终态不可逆：8 没有被「再操作」改回任何别的状态
    expect(afterRow?.status).toBe(8);
  });

  // ── 四、列表可见性（三种视角 + 全量）───────────────────────────────

  it('列表可见性：学生 1 条 / 导师 3 条 / 学院管理员 4 条 / 双创管理员 4 条', async () => {
    const studentList = await listAs('student-1');
    expect(studentList.total).toBe(1);
    expect(studentList.list).toHaveLength(1);
    expect(studentList.list[0].id).toBe(flowAppointmentId.toString());
    expect(
      studentList.list.every(
        (item) => item.studentPersonId === personId('student-1').toString(),
      ),
    ).toBe(true);

    const mentorList = await listAs('mentor-a');
    expect(mentorList.total).toBe(3);
    expect(mentorList.list).toHaveLength(3);
    expect(
      mentorList.list.every(
        (item) => item.mentorProfileId === profileOf('mentor-a').id.toString(),
      ),
    ).toBe(true);
    // 别人的预约（mentor-b 名下）不在导师视角里
    expect(
      mentorList.list.some(
        (item) => item.id === foreignAppointmentId.toString(),
      ),
    ).toBe(false);

    // 另外三条都挂在 student-2 名下（学院 A），学院管理员按申请人部门收窄后全见
    const collegeList = await listAs('college-admin');
    expect(collegeList.total).toBe(4);
    expect(collegeList.list).toHaveLength(4);

    const scList = await listAs('sc-admin');
    expect(scList.total).toBe(4);
    expect(scList.list).toHaveLength(4);
  });
});
