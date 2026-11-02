import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { MentorProfile, SyncPerson } from '@prisma/client';
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
import type {
  SlotListResponseDto,
  SlotResponseDto,
} from '../src/modules/mentor-slot/dto/slot-response.dto';
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

/**
 * 导师时段管理 (e2e) —— Task 21 的全部判据。
 *
 * 执行顺序即判据顺序（共享库态、maxWorkers:1 串行）：重叠 / 相邻 / 不同 weekday
 * 三条共用 beforeAll + 判据 2 建好的「周一 09:00-11:00」；软删与重建共用同一个
 * weekday。`:id` 归属用 mentor-b 去碰 mentor-a 的时段，验 404 / 31201（不是 403）。
 *
 * docs:gen 的 49 路径 / 68 操作由门槛命令核；这里只钉时段面的路由形状
 * （2 条路径 / 4 个操作），与 mentor-material 的同款判据一致。
 */
describe('导师时段管理 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;

  let adminApi: E2eApi;
  const agents = new Map<string, E2eApi>();
  const permissionIds = new Map<string, string>();
  const deptIds = new Map<string, bigint>();
  const people = new Map<string, SyncPerson>();
  const profiles = new Map<string, MentorProfile>();

  /** 判据 2 建的「周一 09:00-11:00」——重叠 / 相邻 / 越权都拿它当基准 */
  let mondayId: bigint;
  /** 判据 3 的 PUT 目标（周三 14:00-16:00 → 15:00-17:00） */
  let wednesdayId: bigint;
  /** 判据 16 建的关闭时段（周六 08:00-09:00，status=0），判据 17 复用它 */
  let saturdayId: bigint;

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
    await clearMentorAndSyncTables(prisma);
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

    // 同步层的行只有同步任务能写（SYNC_WRITE_FORBIDDEN）：测试造数走 runWithSyncWrite
    const orgA = await createOrg('ORG-SLOT-A', '学院 A 组织', dept('A'));
    const orgB = await createOrg('ORG-SLOT-B', '学院 B 组织', dept('B'));

    const identities: Array<[string, string, bigint]> = [
      ['mentor-a', 'internalMentor', orgA],
      ['mentor-b', 'internalMentor', orgB],
      // 有 SyncPerson、没有 MentorProfile：判据「导师无档案 → 404 / 31102」
      ['no-profile', 'internalMentor', orgA],
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

    const slotRole = await createRoleWithCodes(
      '时段导师角色',
      'slot_mentor',
      'self',
      ['mentor:slot-manage'],
    );

    // username = login：身份链（SysUser.username → SyncPerson.login）靠自然键
    const users: Array<[string, bigint, RoleResponseDto]> = [
      ['mentor-a', dept('A'), slotRole],
      ['mentor-b', dept('B'), slotRole],
      ['no-profile', dept('A'), slotRole],
    ];
    for (const [username, deptId, role] of users) {
      const user = await seedUser(prisma, { username, deptId });
      await linkUserRole(user.userId, BigInt(role.id));
    }

    for (const login of ['mentor-a', 'mentor-b', 'no-profile']) {
      const tokens = await loginAs(app, login, 'Passw0rd!');
      agents.set(login, authedAgent(app, tokens.accessToken));
    }

    // mentor-a / mentor-b 各有导师档案；no-profile 没有
    for (const login of ['mentor-a', 'mentor-b']) {
      const profile = await prisma.client.mentorProfile.create({
        data: {
          personId: personId(login),
          researchFields: [],
          status: 2,
          createdBy: 0n,
          updatedBy: 0n,
        },
      });
      profiles.set(login, profile);
    }
  });

  afterAll(async () => {
    try {
      if (prisma !== undefined) {
        await clearMentorAndSyncTables(prisma);
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

  function profileId(login: string): string {
    const profile = profiles.get(login);
    if (profile === undefined) {
      throw new Error(`没有 ${login} 的导师档案`);
    }
    return profile.id.toString();
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

  // ── 判据 1：GET 正例 ─────────────────────────────────────────────

  it('判据 1：GET /mentor/slots → 200，初始为空列表（total 0）', async () => {
    const response = await api('mentor-a').get('/mentor/slots').expect(200);
    const body = response.body as ResponseEnvelope<SlotListResponseDto>;
    expect(body.code).toBe(0);
    expect(body.data).toMatchObject({
      list: [],
      total: 0,
      page: 1,
      pageSize: 0,
    });
  });

  // ── 判据 2：POST 正例 ────────────────────────────────────────────

  it('判据 2：POST 周一 09:00-11:00 → 201，字段 / status 缺省 1 / mentorProfileId 落本人档案', async () => {
    const response = await api('mentor-a')
      .post('/mentor/slots')
      .send({ weekday: 1, startTime: '09:00', endTime: '11:00' })
      .expect(201);
    const data = (response.body as ResponseEnvelope<SlotResponseDto>).data;
    mondayId = BigInt(data.id);

    expect(data).toMatchObject({
      mentorProfileId: profileId('mentor-a'),
      weekday: 1,
      startTime: '09:00',
      endTime: '11:00',
      status: 1,
    });
    expect(data.id).toMatch(/^\d+$/);

    const row = await prisma.client.mentorTimeSlot.findFirst({
      where: { id: mondayId },
    });
    expect(row).toMatchObject({
      mentorProfileId: BigInt(profileId('mentor-a')),
      weekday: 1,
      startTime: '09:00',
      endTime: '11:00',
      status: 1,
    });
  });

  // ── 判据 3：PUT 正例 ─────────────────────────────────────────────

  it('判据 3：PUT 周三 14:00-16:00 → 15:00-17:00 → 200，字段整体替换', async () => {
    const created = await api('mentor-a')
      .post('/mentor/slots')
      .send({ weekday: 3, startTime: '14:00', endTime: '16:00' })
      .expect(201);
    wednesdayId = BigInt(
      (created.body as ResponseEnvelope<SlotResponseDto>).data.id,
    );

    const response = await api('mentor-a')
      .put(`/mentor/slots/${wednesdayId.toString()}`)
      .send({ weekday: 3, startTime: '15:00', endTime: '17:00', status: 0 })
      .expect(200);
    const data = (response.body as ResponseEnvelope<SlotResponseDto>).data;
    expect(data).toMatchObject({
      id: wednesdayId.toString(),
      weekday: 3,
      startTime: '15:00',
      endTime: '17:00',
      status: 0,
    });

    const row = await prisma.client.mentorTimeSlot.findFirst({
      where: { id: wednesdayId },
    });
    expect(row).toMatchObject({
      startTime: '15:00',
      endTime: '17:00',
      status: 0,
    });
  });

  // ── 判据 4：DELETE 正例 ──────────────────────────────────────────

  it('判据 4：DELETE 一条自己的时段 → 204，库里打上 deletedAt（软删）', async () => {
    const created = await api('mentor-a')
      .post('/mentor/slots')
      .send({ weekday: 5, startTime: '07:00', endTime: '08:00' })
      .expect(201);
    const id = BigInt(
      (created.body as ResponseEnvelope<SlotResponseDto>).data.id,
    );

    await api('mentor-a').delete(`/mentor/slots/${id.toString()}`).expect(204);

    const row = await prisma.includingDeleted.mentorTimeSlot.findFirst({
      where: { id },
    });
    expect(row).not.toBeNull();
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.deletedBy).not.toBeNull();
  });

  // ── 判据 5 / 6：weekday 越界 ─────────────────────────────────────

  it('判据 5：weekday=0 / 8 / 1.5 → 各 400 / 10001，data.fields 点名 weekday，无行落库', async () => {
    const before = await prisma.client.mentorTimeSlot.count({});
    for (const weekday of [0, 8, 1.5]) {
      const response = await api('mentor-a')
        .post('/mentor/slots')
        .send({ weekday, startTime: '09:00', endTime: '11:00' })
        .expect(400);
      const body = response.body as ResponseEnvelope<{
        fields: FieldErrorDto[];
      }>;
      expect(body.code).toBe(ErrorCode.PARAM_INVALID);
      expect(body.data.fields.some((f) => f.field === 'weekday')).toBe(true);
    }
    expect(await prisma.client.mentorTimeSlot.count({})).toBe(before);
  });

  // ── 判据 7：endTime <= startTime ─────────────────────────────────

  it('判据 7：endTime 等于 / 早于 startTime → 各 400 / 10001，data.fields 点名 endTime', async () => {
    for (const [startTime, endTime] of [
      ['09:00', '09:00'],
      ['11:00', '09:00'],
    ] as const) {
      const response = await api('mentor-a')
        .post('/mentor/slots')
        .send({ weekday: 2, startTime, endTime })
        .expect(400);
      const body = response.body as ResponseEnvelope<{
        fields: FieldErrorDto[];
      }>;
      expect(body.code).toBe(ErrorCode.PARAM_INVALID);
      expect(body.data.fields.some((f) => f.field === 'endTime')).toBe(true);
    }
  });

  // ── 判据 8：startTime 非法格式 ───────────────────────────────────

  it("判据 8：startTime='25:00' → 400 / 10001，data.fields 点名 startTime", async () => {
    const response = await api('mentor-a')
      .post('/mentor/slots')
      .send({ weekday: 2, startTime: '25:00', endTime: '26:00' })
      .expect(400);
    const body = response.body as ResponseEnvelope<{ fields: FieldErrorDto[] }>;
    expect(body.code).toBe(ErrorCode.PARAM_INVALID);
    expect(body.data.fields.some((f) => f.field === 'startTime')).toBe(true);
  });

  // ── 判据 9：重叠 → 409 / 31206 ───────────────────────────────────

  it('判据 9：已有周一 09:00-11:00，再建周一 10:00-12:00 → 409 / 31206，无行落库', async () => {
    const before = await prisma.client.mentorTimeSlot.count({});
    const response = await api('mentor-a')
      .post('/mentor/slots')
      .send({ weekday: 1, startTime: '10:00', endTime: '12:00' })
      .expect(409);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.MENTOR_SLOT_OVERLAP);
    expect(body.message).toBe('该时段与已有开放时段重叠');
    expect(await prisma.client.mentorTimeSlot.count({})).toBe(before);
  });

  // ── 判据 10：半开区间边界相接不算重叠 ────────────────────────────

  it('判据 10：周一 11:00-12:00（紧邻 09:00-11:00 的结束）→ 201（半开区间）', async () => {
    const response = await api('mentor-a')
      .post('/mentor/slots')
      .send({ weekday: 1, startTime: '11:00', endTime: '12:00' })
      .expect(201);
    expect(
      (response.body as ResponseEnvelope<SlotResponseDto>).data,
    ).toMatchObject({ weekday: 1, startTime: '11:00', endTime: '12:00' });
  });

  // ── 判据 11：不同 weekday 同时段 → 201 ───────────────────────────

  it('判据 11：周二 09:00-11:00（与周一同时段）→ 201', async () => {
    const response = await api('mentor-a')
      .post('/mentor/slots')
      .send({ weekday: 2, startTime: '09:00', endTime: '11:00' })
      .expect(201);
    expect(
      (response.body as ResponseEnvelope<SlotResponseDto>).data,
    ).toMatchObject({ weekday: 2, startTime: '09:00', endTime: '11:00' });
  });

  // ── 判据 12：别人的时段 → 404 / 31201（不是 403）─────────────────

  it('判据 12：mentor-b 改 / 删 mentor-a 的时段 → 各 404 / 31201，原行未被改动 / 软删', async () => {
    for (const method of ['put', 'delete'] as const) {
      const request =
        method === 'put'
          ? api('mentor-b')
              .put(`/mentor/slots/${mondayId.toString()}`)
              .send({ weekday: 1, startTime: '09:00', endTime: '11:00' })
          : api('mentor-b').delete(`/mentor/slots/${mondayId.toString()}`);
      const response = await request.expect(404);
      const body = response.body as ResponseEnvelope<null>;
      expect(body.code).toBe(ErrorCode.MENTOR_SLOT_NOT_FOUND);
      expect(body.message).toBe('可指导时段不存在');
    }

    const row = await prisma.includingDeleted.mentorTimeSlot.findFirst({
      where: { id: mondayId },
    });
    expect(row).not.toBeNull();
    expect(row?.deletedAt).toBeNull();
    expect(row?.startTime).toBe('09:00');
    expect(row?.endTime).toBe('11:00');
  });

  // ── 判据 13：软删后列表不出、同一时段可重建 ──────────────────────

  it('判据 13：软删周五 09:00-11:00 → 列表不再出现 → 同一 weekday 同一时间可重建（201）', async () => {
    const created = await api('mentor-a')
      .post('/mentor/slots')
      .send({ weekday: 5, startTime: '09:00', endTime: '11:00' })
      .expect(201);
    const id = BigInt(
      (created.body as ResponseEnvelope<SlotResponseDto>).data.id,
    );

    await api('mentor-a').delete(`/mentor/slots/${id.toString()}`).expect(204);

    const list = await api('mentor-a').get('/mentor/slots').expect(200);
    const body = list.body as ResponseEnvelope<SlotListResponseDto>;
    expect(body.data.list.map((item) => item.id)).not.toContain(id.toString());

    // 同一 weekday 同一时间可重建（唯一性 / 重叠判定只看未删行）
    const recreated = await api('mentor-a')
      .post('/mentor/slots')
      .send({ weekday: 5, startTime: '09:00', endTime: '11:00' })
      .expect(201);
    const data = (recreated.body as ResponseEnvelope<SlotResponseDto>).data;
    expect(BigInt(data.id)).not.toBe(id);
    expect(data).toMatchObject({
      weekday: 5,
      startTime: '09:00',
      endTime: '11:00',
    });

    // 软删行仍在，只是被过滤
    const deleted = await prisma.includingDeleted.mentorTimeSlot.findFirst({
      where: { id },
    });
    expect(deleted?.deletedAt).not.toBeNull();
  });

  // ── 判据 14：导师无档案 → 404 / 31102 ────────────────────────────

  it('判据 14：有 SyncPerson 但无 MentorProfile → 四条路由均 404 / 31102', async () => {
    // 请求必须**逐个**建、逐个 await：supertest 在最后一个 pending 请求结束后
    // 会把自启的 server 关掉，一次性建好四个再依次 await 时，第二个开始就
    // 撞上「server 已关、address() 为 null」。
    const assertNoProfile = (response: { body: unknown }): void => {
      const body = response.body as ResponseEnvelope<null>;
      expect(body.code).toBe(ErrorCode.MENTOR_PROFILE_NOT_FOUND);
      expect(body.message).toBe('导师专业档案不存在');
    };

    assertNoProfile(await api('no-profile').get('/mentor/slots').expect(404));
    assertNoProfile(
      await api('no-profile')
        .post('/mentor/slots')
        .send({ weekday: 1, startTime: '09:00', endTime: '11:00' })
        .expect(404),
    );
    assertNoProfile(
      await api('no-profile')
        .put('/mentor/slots/1')
        .send({ weekday: 1, startTime: '09:00', endTime: '11:00' })
        .expect(404),
    );
    assertNoProfile(
      await api('no-profile').delete('/mentor/slots/1').expect(404),
    );
  });

  // ── 判据 15：时段面恰好 2 条路径 / 4 个操作 ──────────────────────

  it('判据 15：时段面恰好 2 条路径 / 4 个操作（docs:gen 总数由门槛命令核）', () => {
    const document = buildDocument(app);
    const paths = document.paths as Record<string, Record<string, unknown>>;
    const slotPaths = Object.keys(paths).filter((path) =>
      path.startsWith('/mentor/slots'),
    );
    expect(slotPaths.sort()).toEqual(['/mentor/slots', '/mentor/slots/{id}']);
    const operations = slotPaths.reduce(
      (sum, path) =>
        sum +
        Object.keys(paths[path]).filter((key) =>
          ['get', 'post', 'put', 'delete', 'patch'].includes(key),
        ).length,
      0,
    );
    expect(operations).toBe(4);
  });

  // ── 判据 16：PUT 省略 status 保留原值（返工轮 1） ─────────────────

  it('判据 16：建 status=0 的时段 → PUT 只改 endTime、不传 status → status 仍是 0', async () => {
    const created = await api('mentor-a')
      .post('/mentor/slots')
      .send({ weekday: 6, startTime: '08:00', endTime: '09:00', status: 0 })
      .expect(201);
    const createdBody = created.body as ResponseEnvelope<SlotResponseDto>;
    const createdData = createdBody.data;
    expect(createdData.status).toBe(0);
    saturdayId = BigInt(createdData.id);

    const response = await api('mentor-a')
      .put(`/mentor/slots/${saturdayId.toString()}`)
      .send({ weekday: 6, startTime: '08:00', endTime: '10:00' })
      .expect(200);
    const data = (response.body as ResponseEnvelope<SlotResponseDto>).data;
    expect(data).toMatchObject({
      id: saturdayId.toString(),
      endTime: '10:00',
      status: 0,
    });

    const row = await prisma.client.mentorTimeSlot.findFirst({
      where: { id: saturdayId },
    });
    expect(row).toMatchObject({ endTime: '10:00', status: 0 });
  });

  // ── 判据 17：status=null → 400 / 10001，点名 status（返工轮 1） ──

  it('判据 17：PUT 传 status: null → 400 / 10001，data.fields 点名 status，行未被改动', async () => {
    const response = await api('mentor-a')
      .put(`/mentor/slots/${saturdayId.toString()}`)
      .send({
        weekday: 6,
        startTime: '08:00',
        endTime: '11:00',
        status: null,
      })
      .expect(400);
    const body = response.body as ResponseEnvelope<{ fields: FieldErrorDto[] }>;
    expect(body.code).toBe(ErrorCode.PARAM_INVALID);
    expect(body.data.fields.some((f) => f.field === 'status')).toBe(true);

    const row = await prisma.client.mentorTimeSlot.findFirst({
      where: { id: saturdayId },
    });
    expect(row).toMatchObject({ endTime: '10:00', status: 0 });
  });
});

/**
 * 清残留（照 mentor-material.e2e-spec.ts 的同名函数）。走裸 SQL：清库是测试的
 * 运维动作，不是业务写入。顺序按外键拓扑序——预约域先于时段，时段先于档案，
 * 档案先于 sync_person / sync_org_unit。
 */
async function clearMentorAndSyncTables(prisma: PrismaService): Promise<void> {
  for (const table of [
    'achievement',
    'assessment_appeal',
    'assessment',
    'student_review',
    'guidance_material',
    'guidance_record',
    'appointment_material',
    'appointment',
    'mentor_time_slot',
    'mentor_application_material',
    'mentor_application',
    'mentor_profile',
    'sync_person',
    'sync_org_unit',
  ]) {
    await prisma.client.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
}
