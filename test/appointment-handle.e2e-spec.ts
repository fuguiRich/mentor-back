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
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 预约处理（导师）(e2e) —— Task 24 的全部判据。
 *
 * 共享库态、`maxWorkers: 1` 串行。每个用例**自建自己的预约行**（直接写库），
 * 因此用例之间没有执行顺序依赖：
 * - 学生 S001（只有 `appointment:create`，没有 `appointment:handle`）；
 * - 导师 T001（`appointment:handle`，预约的导师本人）、T002（同码，别的导师）；
 * - T001 / T002 各有已生效的导师档案；T001 有一条周一 09:00-11:00 的开放时段，
 *   专门用来钉死 R33「reschedule 不校验时段」。
 *
 * docs:gen 的 56 路径 / 75 操作由门槛命令核；本套件钉三条处理路由的**行为**。
 */
describe('预约处理（导师）(e2e)', () => {
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
    deptIds.set('B', await createDept('学院 B', rootDept.id));

    const orgA = await createOrg('ORG-HANDLE-A', '学院 A 组织', dept('A'));
    const orgB = await createOrg('ORG-HANDLE-B', '学院 B 组织', dept('B'));

    const identities: Array<[string, string, bigint]> = [
      ['S001', 'student', orgA],
      ['T001', 'internalMentor', orgA],
      ['T002', 'internalMentor', orgB],
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
      '预约处理学生角色',
      'handle_student',
      'self',
      ['appointment:create'],
    );
    const mentorRole = await createRoleWithCodes(
      '预约处理导师角色',
      'handle_mentor',
      'self',
      ['appointment:handle'],
    );

    const users: Array<[string, bigint, RoleResponseDto]> = [
      ['S001', dept('A'), studentRole],
      ['T001', dept('A'), mentorRole],
      ['T002', dept('B'), mentorRole],
    ];
    for (const [username, deptId, role] of users) {
      const user = await seedUser(prisma, { username, deptId });
      await linkUserRole(user.userId, BigInt(role.id));
    }

    for (const login of ['S001', 'T001', 'T002']) {
      const tokens = await loginAs(app, login, 'Passw0rd!');
      agents.set(login, authedAgent(app, tokens.accessToken));
    }

    for (const login of ['T001', 'T002']) {
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

    // T001 的开放时段：周一 09:00-11:00（R33 判据的对照物——改期到时段之外也必须 200）
    await prisma.client.mentorTimeSlot.create({
      data: {
        mentorProfileId: profileOf('T001').id,
        weekday: 1,
        startTime: '09:00',
        endTime: '11:00',
        status: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
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

  /** 未来 7 天后的一个时刻：只作为 `requestedTime` 的占位，不参与任何时段校验 */
  function requestedTimeFixture(): Date {
    return new Date(Date.now() + 7 * DAY_MS);
  }

  /** 未来 14 天后的一个时刻：`reschedule` 的合法 `proposedTime` */
  function proposedTimeFixture(): Date {
    return new Date(Date.now() + 14 * DAY_MS);
  }

  /** Asia/Shanghai 全年无夏令时，固定 +08:00 */
  const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

  /** 未来最近一次「**北京时间** weekday 的 HH:mm」对应的 UTC 时刻，留 60 秒余量 */
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

  async function createAppointment(
    overrides: Partial<Appointment> = {},
  ): Promise<Appointment> {
    return prisma.client.appointment.create({
      data: {
        studentPersonId: personId('S001'),
        mentorProfileId: profileOf('T001').id,
        type: 1,
        status: 0,
        requestedTime: requestedTimeFixture(),
        topic: '挑战杯选题与打磨',
        questions: '如何把技术方案讲成一个好故事？',
        mode: 1,
        createdBy: 0n,
        updatedBy: 0n,
        ...overrides,
      },
    });
  }

  function expectFieldError(response: { body: unknown }, field: string): void {
    const data = response.body as ResponseEnvelope<{ fields: FieldErrorDto[] }>;
    expect(data.code).toBe(ErrorCode.PARAM_INVALID);
    expect(data.data.fields.some((f) => f.field === field)).toBe(true);
  }

  // ── confirm ──────────────────────────────────────────────────────

  it('confirm：0 → 1，handleComment 落库', async () => {
    const appointment = await createAppointment();
    const response = await api('T001')
      .post(`/appointments/${appointment.id}/confirm`)
      .send({ comment: '时间没问题，请准时参加' })
      .expect(200);

    const data = (response.body as ResponseEnvelope<AppointmentResponseDto>)
      .data;
    expect(data).toMatchObject({
      id: appointment.id.toString(),
      status: 1,
      handleComment: '时间没问题，请准时参加',
      rejectReason: null,
    });

    const row = await prisma.client.appointment.findFirst({
      where: { id: appointment.id },
    });
    expect(row?.status).toBe(1);
    expect(row?.handleComment).toBe('时间没问题，请准时参加');
  });

  it('confirm 不传 comment → 200，handleComment 为 null', async () => {
    const appointment = await createAppointment();
    const response = await api('T001')
      .post(`/appointments/${appointment.id}/confirm`)
      .send({})
      .expect(200);

    const data = (response.body as ResponseEnvelope<AppointmentResponseDto>)
      .data;
    expect(data.status).toBe(1);
    expect(data.handleComment).toBeNull();

    const row = await prisma.client.appointment.findFirst({
      where: { id: appointment.id },
    });
    expect(row?.status).toBe(1);
    expect(row?.handleComment).toBeNull();
  });

  // ── reject ───────────────────────────────────────────────────────

  it('reject：0 → 7，rejectReason 落库', async () => {
    const appointment = await createAppointment();
    const response = await api('T001')
      .post(`/appointments/${appointment.id}/reject`)
      .send({ reason: '该时段已排满，请另约时间' })
      .expect(200);

    const data = (response.body as ResponseEnvelope<AppointmentResponseDto>)
      .data;
    expect(data).toMatchObject({
      status: 7,
      rejectReason: '该时段已排满，请另约时间',
    });

    const row = await prisma.client.appointment.findFirst({
      where: { id: appointment.id },
    });
    expect(row?.status).toBe(7);
    expect(row?.rejectReason).toBe('该时段已排满，请另约时间');
  });

  it('reject 缺 reason → 400 / 10001，点名 reason', async () => {
    const appointment = await createAppointment();
    const response = await api('T001')
      .post(`/appointments/${appointment.id}/reject`)
      .send({})
      .expect(400);
    expectFieldError(response, 'reason');
  });

  it('reject 的 reason 为 501 字 → 400 / 10001，点名 reason', async () => {
    const appointment = await createAppointment();
    const response = await api('T001')
      .post(`/appointments/${appointment.id}/reject`)
      .send({ reason: '因'.repeat(501) })
      .expect(400);
    expectFieldError(response, 'reason');
  });

  // ── reschedule ───────────────────────────────────────────────────

  it('reschedule：status 仍是 0、proposedTime 变了、requestedTime 一字未变、handleComment 落库', async () => {
    const originalRequested = new Date('2026-12-01T02:00:00.000Z');
    const appointment = await createAppointment({
      requestedTime: originalRequested,
    });
    const proposed = proposedTimeFixture();

    const response = await api('T001')
      .post(`/appointments/${appointment.id}/reschedule`)
      .send({
        proposedTime: proposed.toISOString(),
        comment: '原时间有冲突，改到两周后',
      })
      .expect(200);

    const data = (response.body as ResponseEnvelope<AppointmentResponseDto>)
      .data;
    expect(data).toMatchObject({
      status: 0,
      proposedTime: proposed.toISOString(),
      requestedTime: originalRequested.toISOString(),
      handleComment: '原时间有冲突，改到两周后',
    });

    const row = await prisma.client.appointment.findFirst({
      where: { id: appointment.id },
    });
    expect(row?.status).toBe(0);
    expect(row?.proposedTime?.toISOString()).toBe(proposed.toISOString());
    expect(row?.requestedTime.toISOString()).toBe(
      originalRequested.toISOString(),
    );
    expect(row?.handleComment).toBe('原时间有冲突，改到两周后');
  });

  it('reschedule 的 proposedTime 是过去时间 → 400 / 10001，点名 proposedTime', async () => {
    const appointment = await createAppointment();
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const response = await api('T001')
      .post(`/appointments/${appointment.id}/reschedule`)
      .send({ proposedTime: past })
      .expect(400);
    expectFieldError(response, 'proposedTime');
  });

  it('R33：proposedTime 落在导师开放时段之外 → 仍然 200', async () => {
    // T001 的开放时段是周一 09:00-11:00；这里改到**周三 03:00**（北京时间），
    // 明确落在时段之外。reschedule 不校验时段，必须放行。
    const appointment = await createAppointment();
    const outside = futureAt(3, '03:00');
    const response = await api('T001')
      .post(`/appointments/${appointment.id}/reschedule`)
      .send({ proposedTime: outside.toISOString() })
      .expect(200);

    const data = (response.body as ResponseEnvelope<AppointmentResponseDto>)
      .data;
    expect(data.status).toBe(0);
    expect(data.proposedTime).toBe(outside.toISOString());
  });

  // ── 路径参数：`:id` 不是数字 → 400 / 10001 ───────────────────────

  it('路径 id 不是数字（/appointments/abc/confirm）→ 400 / 10001，点名 id', async () => {
    const response = await api('T001')
      .post('/appointments/abc/confirm')
      .send({ comment: 'x' })
      .expect(400);

    expectFieldError(response, 'id');
  });

  // ── 守卫 1：预约不存在 → 404 / 32001 ─────────────────────────────

  it('预约不存在 → 三个动作各 404 / 32001', async () => {
    const missingId = '999999999';
    const cases: Array<{ path: string; body: Record<string, unknown> }> = [
      { path: 'confirm', body: { comment: 'x' } },
      { path: 'reject', body: { reason: 'x' } },
      {
        path: 'reschedule',
        body: { proposedTime: proposedTimeFixture().toISOString() },
      },
    ];
    for (const testCase of cases) {
      const response = await api('T001')
        .post(`/appointments/${missingId}/${testCase.path}`)
        .send(testCase.body)
        .expect(404);
      const data = response.body as ResponseEnvelope<null>;
      expect(data.code).toBe(ErrorCode.APPOINTMENT_NOT_FOUND);
      expect(data.message).toBe('预约不存在');
    }
  });

  // ── 守卫 2：不是该预约的导师本人 → 403 / 32002 ───────────────────

  it('别的导师 T002 调三个动作 → 各 403 / 32002', async () => {
    const appointment = await createAppointment();
    const cases: Array<{ path: string; body: Record<string, unknown> }> = [
      { path: 'confirm', body: { comment: 'x' } },
      { path: 'reject', body: { reason: 'x' } },
      {
        path: 'reschedule',
        body: { proposedTime: proposedTimeFixture().toISOString() },
      },
    ];
    for (const testCase of cases) {
      const response = await api('T002')
        .post(`/appointments/${appointment.id}/${testCase.path}`)
        .send(testCase.body)
        .expect(403);
      const data = response.body as ResponseEnvelope<null>;
      expect(data.code).toBe(ErrorCode.APPOINTMENT_FORBIDDEN);
      expect(data.message).toBe('无权访问该预约');
    }
  });

  // ── 学生调三个动作：缺 appointment:handle，被权限守卫挡下 ─────────

  it('学生 S001 调三个动作 → 403 / 10003（缺 appointment:handle，不是 32002）', async () => {
    const appointment = await createAppointment();
    const cases: Array<{ path: string; body: Record<string, unknown> }> = [
      { path: 'confirm', body: { comment: 'x' } },
      { path: 'reject', body: { reason: 'x' } },
      {
        path: 'reschedule',
        body: { proposedTime: proposedTimeFixture().toISOString() },
      },
    ];
    for (const testCase of cases) {
      const response = await api('S001')
        .post(`/appointments/${appointment.id}/${testCase.path}`)
        .send(testCase.body)
        .expect(403);
      const data = response.body as ResponseEnvelope<null>;
      // 权限守卫先于 Controller / Service：学生没有 appointment:handle
      expect(data.code).toBe(ErrorCode.FORBIDDEN);
      expect(data.message).toContain('appointment:handle');
    }
  });

  // ── 守卫 3：status != 0 → 409 / 32003 ───────────────────────────

  it('status != 0（1 / 7）时三个动作各 409 / 32003', async () => {
    const cases: Array<{ path: string; body: Record<string, unknown> }> = [
      { path: 'confirm', body: { comment: 'x' } },
      { path: 'reject', body: { reason: 'x' } },
      {
        path: 'reschedule',
        body: { proposedTime: proposedTimeFixture().toISOString() },
      },
    ];
    for (const status of [1, 7]) {
      const appointment = await createAppointment({ status });
      for (const testCase of cases) {
        const response = await api('T001')
          .post(`/appointments/${appointment.id}/${testCase.path}`)
          .send(testCase.body)
          .expect(409);
        const data = response.body as ResponseEnvelope<null>;
        expect(data.code).toBe(ErrorCode.APPOINTMENT_TRANSITION_INVALID);
        expect(data.message).toBe('当前状态不允许该操作');
      }
      // 全部被拒后状态没被改
      const row = await prisma.client.appointment.findFirst({
        where: { id: appointment.id },
      });
      expect(row?.status).toBe(status);
    }
  });

  // ── 并发：同一预约双发 confirm，恰一方 200、另一方 409 ───────────

  it('同一预约并发双发 confirm → 恰 1×200 + 1×409 / 32003（跑 3 轮）', async () => {
    // 两个请求都读到 status=0 之后才写，靠条件更新（UPDATE … WHERE status=0）
    // 决出唯一赢家。没有这道条件更新，两个都会 200——契约上第二个必须是 409。
    for (let round = 0; round < 3; round += 1) {
      const appointment = await createAppointment();
      const url = `/appointments/${appointment.id}/confirm`;
      const comments = [`并发 A-${round}`, `并发 B-${round}`];

      const [first, second] = await Promise.all([
        api('T001').post(url).send({ comment: comments[0] }),
        api('T001').post(url).send({ comment: comments[1] }),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);

      const loser = first.status === 409 ? first : second;
      const loserBody = loser.body as ResponseEnvelope<null>;
      expect(loserBody.code).toBe(ErrorCode.APPOINTMENT_TRANSITION_INVALID);
      expect(loserBody.message).toBe('当前状态不允许该操作');

      const row = await prisma.client.appointment.findFirst({
        where: { id: appointment.id },
      });
      expect(row?.status).toBe(1);
      // 恰好一份意见：赢家的那一条，不是两次写叠加
      expect(comments).toContain(row?.handleComment);
    }
  });
});

/**
 * 清预约域 + 同步层的残留（照 appointment.e2e-spec.ts 的同名函数）。
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
