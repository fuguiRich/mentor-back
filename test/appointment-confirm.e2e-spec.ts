import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Appointment, MentorProfile, SyncPerson } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { runWithSyncWrite } from '../src/infra/prisma/sync-write-scope';
import { ErrorCode } from '../src/common/constants/error-code';
import type { FieldErrorDto } from '../src/common/dto/field-error.dto';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import type { PermissionResponseDto } from '../src/modules/permission/dto/permission-response.dto';
import type { RoleResponseDto } from '../src/modules/role/dto/role-response.dto';
import type { AppointmentResponseDto } from '../src/modules/appointment/dto/appointment-response.dto';
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
const HOUR_MS = 60 * 60 * 1000;

/**
 * 学生确认指导记录 / 提异议（e2e）—— Task 27 的全部判据。
 *
 * 共享库态、`maxWorkers: 1` 串行。每个用例**自建自己的预约行**（直接写库），
 * 因此用例之间没有执行顺序依赖：
 * - 学生 S001（`appointment:create`，预约的申请人）；
 * - 学生 S002（同码，不是申请人）——用来钉「403 / 32002」；
 * - 导师 T001（`appointment:handle`，**没有** `appointment:create`）——用来钉
 *   「权限守卫先挡，403 / 10003」。
 *
 * docs:gen 的 65 路径 / 87 操作由门槛命令核；本套件钉两条学生路由的**行为**。
 */
describe('学生确认记录 / 提异议 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;

  let adminApi: E2eApi;
  const agents = new Map<string, E2eApi>();
  const permissionIds = new Map<string, string>();
  const deptIds = new Map<string, bigint>();
  const people = new Map<string, SyncPerson>();
  const profiles = new Map<string, MentorProfile>();

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
    deptIds.set('A', await createDept('学院 A', rootDept.id));

    const orgA = await createOrg('ORG-CONFIRM-A', '学院 A 组织', dept('A'));

    const identities: Array<[string, string, bigint]> = [
      ['S001', 'student', orgA],
      ['S002', 'student', orgA],
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
      '确认记录学生角色',
      'confirm_student',
      'self',
      ['appointment:create'],
    );
    const mentorRole = await createRoleWithCodes(
      '确认记录导师角色',
      'confirm_mentor',
      'self',
      ['appointment:handle'],
    );

    const users: Array<[string, bigint, RoleResponseDto]> = [
      ['S001', dept('A'), studentRole],
      ['S002', dept('A'), studentRole],
      ['T001', dept('A'), mentorRole],
    ];
    for (const [username, deptId, role] of users) {
      const user = await seedUser(prisma, { username, deptId });
      await linkUserRole(user.userId, BigInt(role.id));
    }

    for (const login of ['S001', 'S002', 'T001']) {
      const tokens = await loginAs(app, login, 'Passw0rd!');
      agents.set(login, authedAgent(app, tokens.accessToken));
    }

    const profile = await prisma.client.mentorProfile.create({
      data: {
        personId: personId('T001'),
        researchFields: [],
        status: 2,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    profiles.set('T001', profile);
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
    deptId: bigint | null,
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

  async function createAppointment(
    overrides: Partial<Appointment> = {},
  ): Promise<Appointment> {
    return prisma.client.appointment.create({
      data: {
        studentPersonId: personId('S001'),
        mentorProfileId: profileOf('T001').id,
        type: 1,
        // 默认 3 RECORD_SUBMITTED：确认记录 / 提异议的合法出发态
        status: 3,
        requestedTime: new Date(Date.now() - 24 * HOUR_MS),
        topic: '挑战杯选题与打磨',
        questions: '如何把技术方案讲成一个好故事？',
        mode: 1,
        createdBy: 0n,
        updatedBy: 0n,
        ...overrides,
      },
    });
  }

  async function findAppointment(id: bigint): Promise<Appointment | null> {
    return prisma.client.appointment.findFirst({ where: { id } });
  }

  function expectFieldError(response: { body: unknown }, field: string): void {
    const data = response.body as ResponseEnvelope<{ fields: FieldErrorDto[] }>;
    expect(data.code).toBe(ErrorCode.PARAM_INVALID);
    expect(data.data.fields.some((f) => f.field === field)).toBe(true);
  }

  // ── confirm-record：3 → 4 ───────────────────────────────────────

  it('confirm-record：status 3 → 4，200，**不直接到 6**', async () => {
    const appointment = await createAppointment();

    const response = await api('S001')
      .post(`/appointments/${appointment.id}/confirm-record`)
      .expect(200);

    const data = (response.body as ResponseEnvelope<AppointmentResponseDto>)
      .data;
    expect(data.status).toBe(4);
    expect(data.disputeReason).toBeNull();

    const row = await findAppointment(appointment.id);
    expect(row?.status).toBe(4);
    expect(row?.disputeReason).toBeNull();
  });

  it('R36：管理员退回后重确认（status=3 且 disputeReason 非 null）→ disputeReason 清空', async () => {
    // 模拟「学生异议 → 管理员退回 5 → 3」后的状态：仍在 3，但异议原因保留。
    // 学生再次确认即表示异议已自行解决，confirm-record 必须把它清成 null，
    // 否则会留下 status = 4 且 disputeReason 非 null 的脏态。
    const appointment = await createAppointment({
      disputeReason: '上一轮未决的异议原因',
    });

    const response = await api('S001')
      .post(`/appointments/${appointment.id}/confirm-record`)
      .expect(200);

    const data = (response.body as ResponseEnvelope<AppointmentResponseDto>)
      .data;
    expect(data.status).toBe(4);
    expect(data.disputeReason).toBeNull();

    const row = await findAppointment(appointment.id);
    expect(row?.status).toBe(4);
    expect(row?.disputeReason).toBeNull();
  });

  // ── dispute：3 → 5 ──────────────────────────────────────────────

  it('dispute：status 3 → 5，reason 落 disputeReason（不复用 rejectReason）', async () => {
    const appointment = await createAppointment();
    const reason = '记录中的实际指导时间与当天安排不符，请复核。';

    const response = await api('S001')
      .post(`/appointments/${appointment.id}/dispute`)
      .send({ reason })
      .expect(200);

    const data = (response.body as ResponseEnvelope<AppointmentResponseDto>)
      .data;
    expect(data.status).toBe(5);
    expect(data.disputeReason).toBe(reason);
    expect(data.rejectReason).toBeNull();

    const row = await findAppointment(appointment.id);
    expect(row?.status).toBe(5);
    expect(row?.disputeReason).toBe(reason);
    expect(row?.rejectReason).toBeNull();
  });

  // ── 状态门：两个动作各在 0 / 1 / 4 / 6 态 → 409 / 32003 ─────────

  it('两个动作在 0 / 1 / 4 / 6 态 → 各 409 / 32003，且状态不变', async () => {
    for (const status of [0, 1, 4, 6]) {
      for (const [action, body] of [
        ['confirm-record', {}],
        ['dispute', { reason: '时间不符' }],
      ] as const) {
        const appointment = await createAppointment({ status });
        const response = await api('S001')
          .post(`/appointments/${appointment.id}/${action}`)
          .send(body)
          .expect(409);

        const data = response.body as ResponseEnvelope<null>;
        expect(data.code).toBe(ErrorCode.APPOINTMENT_TRANSITION_INVALID);
        expect(data.message).toBe('当前状态不允许该操作');

        const row = await findAppointment(appointment.id);
        expect(row?.status).toBe(status);
      }
    }
  });

  // ── 守卫顺序：403 先于 409 ──────────────────────────────────────

  it('别的学生 S002 调别人的、且 status = 6 的预约 → 403 / 32002（不是 32003）', async () => {
    // 预约属于 S001、已是终态 6；S002 有 appointment:create 但不是申请人。
    // 若守卫顺序反了会先撞状态给出 32003，这里钉死「归属不符」必须赢。
    const appointment = await createAppointment({ status: 6 });
    for (const action of ['confirm-record', 'dispute'] as const) {
      const response = await api('S002')
        .post(`/appointments/${appointment.id}/${action}`)
        .send(action === 'dispute' ? { reason: '时间不符' } : {})
        .expect(403);

      const data = response.body as ResponseEnvelope<null>;
      expect(data.code).toBe(ErrorCode.APPOINTMENT_FORBIDDEN);
      expect(data.message).toBe('无权访问该预约');
    }

    const row = await findAppointment(appointment.id);
    expect(row?.status).toBe(6);
  });

  // ── 404 ─────────────────────────────────────────────────────────

  it('不存在的 :id → 404 / 32001（两个动作各一次）', async () => {
    for (const action of ['confirm-record', 'dispute'] as const) {
      const response = await api('S001')
        .post(`/appointments/999999999/${action}`)
        .send(action === 'dispute' ? { reason: '时间不符' } : {})
        .expect(404);

      const data = response.body as ResponseEnvelope<null>;
      expect(data.code).toBe(ErrorCode.APPOINTMENT_NOT_FOUND);
      expect(data.message).toBe('预约不存在');
    }
  });

  // ── 权限守卫先挡：导师没有 appointment:create ───────────────────

  it('导师 T001 调这两个 → 403 / 10003（缺 appointment:create，权限守卫先挡）', async () => {
    const appointment = await createAppointment();
    for (const action of ['confirm-record', 'dispute'] as const) {
      const response = await api('T001')
        .post(`/appointments/${appointment.id}/${action}`)
        .send(action === 'dispute' ? { reason: '时间不符' } : {})
        .expect(403);

      const data = response.body as ResponseEnvelope<null>;
      expect(data.code).toBe(ErrorCode.FORBIDDEN);
      expect(data.message).toContain('appointment:create');
    }

    const row = await findAppointment(appointment.id);
    expect(row?.status).toBe(3);
  });

  // ── 参数校验 ────────────────────────────────────────────────────

  it('confirm-record 带请求体字段 → 400 / 10001', async () => {
    const appointment = await createAppointment();
    const response = await api('S001')
      .post(`/appointments/${appointment.id}/confirm-record`)
      .send({ comment: '不该收的字段' })
      .expect(400);

    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.PARAM_INVALID);

    const row = await findAppointment(appointment.id);
    expect(row?.status).toBe(3);
  });

  it('dispute 缺 reason / 空串 / 501 字 → 各 400，点名 reason', async () => {
    const bodies: Array<Record<string, unknown>> = [
      {},
      { reason: '' },
      { reason: '字'.repeat(501) },
    ];
    for (const body of bodies) {
      const appointment = await createAppointment();
      const response = await api('S001')
        .post(`/appointments/${appointment.id}/dispute`)
        .send(body)
        .expect(400);
      expectFieldError(response, 'reason');

      const row = await findAppointment(appointment.id);
      expect(row?.status).toBe(3);
      expect(row?.disputeReason).toBeNull();
    }
  });

  // ── 并发双发：条件更新保证恰一次成功 ─────────────────────────────

  it('并发双发 confirm-record → 恰 1×200 + 1×409 / 32003（跑 3 轮）', async () => {
    for (let round = 0; round < 3; round += 1) {
      const appointment = await createAppointment();

      const [first, second] = await Promise.all([
        api('S001').post(`/appointments/${appointment.id}/confirm-record`),
        api('S001').post(`/appointments/${appointment.id}/confirm-record`),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);

      const loser = first.status === 409 ? first : second;
      const data = loser.body as ResponseEnvelope<null>;
      expect(data.code).toBe(ErrorCode.APPOINTMENT_TRANSITION_INVALID);
      expect(data.message).toBe('当前状态不允许该操作');

      const row = await findAppointment(appointment.id);
      expect(row?.status).toBe(4);
    }
  });
});

/**
 * 清预约域 + 同步层的残留（照 appointment-record.e2e-spec.ts 的同名函数）。
 *
 * 走 `includingDeleted`（物理删除）而不是裸 SQL：实体表在 `client` 上的
 * delete 会被 R24 守卫拒掉，`includingDeleted` 才是清库的合法出口。
 * 同步表即使在 `includingDeleted` 上也受 `SYNC_WRITE_FORBIDDEN` 约束，
 * 故包一层 `runWithSyncWrite`（测试造数 / 清库，不是业务写）。
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
