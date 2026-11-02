import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type {
  Appointment,
  GuidanceRecord,
  MentorProfile,
  SyncPerson,
} from '@prisma/client';
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
const HOUR_MS = 60 * 60 * 1000;

/**
 * 异议复核 + 记录重填（e2e）—— Task 28 / R36 / R37 的全部判据。
 *
 * 共享库态、`maxWorkers: 1` 串行。每个用例**自建自己的预约行**（直接写库），
 * 用例之间没有执行顺序依赖：
 * - 学生 S001（`appointment:create`，用来验 R37 之后仍能 `3 → 4`）/ S002（学院 B，仅作申请人）；
 * - 导师 T001（预约的导师本人，`appointment:handle`）；
 * - 导师 T002（同码，别的导师）；
 * - 学院 A / B 的管理员（`appointment:adjudicate` + `deptAndChildren`），
 *   钉「本院可复核 / 外院 403 / 10003」；
 * - 双创学院管理员 sc_admin（`appointment:adjudicate` + `all`，部门挂根节点），
 *   钉「两个层级都能审、覆盖所有学院」（需求 §4.3 的共有需求）。
 *
 * docs:gen 的 65 路径 / 87 操作由门槛命令核；本套件钉 adjudicate 与重填的**行为**。
 */
describe('异议复核 / 记录重填 (e2e)', () => {
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
    deptIds.set('ROOT', rootDept.id);
    deptIds.set('A', await createDept('学院 A', rootDept.id));
    deptIds.set('B', await createDept('学院 B', rootDept.id));

    const orgA = await createOrg('ORG-ADJ-A', '学院 A 组织', dept('A'));
    const orgB = await createOrg('ORG-ADJ-B', '学院 B 组织', dept('B'));

    const identities: Array<[string, string, bigint]> = [
      ['S001', 'student', orgA],
      ['S002', 'student', orgB],
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
      '复核学生角色',
      'adj_student',
      'self',
      ['appointment:create'],
    );
    const mentorRole = await createRoleWithCodes(
      '复核导师角色',
      'adj_mentor',
      'self',
      ['appointment:handle'],
    );
    const collegeAdminRole = await createRoleWithCodes(
      '复核学院管理员角色',
      'adj_college_admin',
      'deptAndChildren',
      ['appointment:adjudicate'],
    );
    // 双创学院管理员（sc_admin）：数据范围 all，clamp 到接口上限 dept 后
    // 仍是「本部门 + 全部下级」——用来验证它能复核**任一**学院的单
    const scAdminRole = await createRoleWithCodes(
      '复核双创学院管理员角色',
      'adj_sc_admin',
      'all',
      ['appointment:adjudicate'],
    );

    const users: Array<[string, bigint, RoleResponseDto]> = [
      ['S001', dept('A'), studentRole],
      ['T001', dept('A'), mentorRole],
      ['T002', dept('B'), mentorRole],
      ['adminA', dept('A'), collegeAdminRole],
      ['adminB', dept('B'), collegeAdminRole],
      ['scAdmin', dept('ROOT'), scAdminRole],
    ];
    for (const [username, deptId, role] of users) {
      const user = await seedUser(prisma, { username, deptId });
      await linkUserRole(user.userId, BigInt(role.id));
    }

    for (const login of [
      'S001',
      'T001',
      'T002',
      'adminA',
      'adminB',
      'scAdmin',
    ]) {
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

  /** 合法的重填请求体：actualTime 取一小时前（R35：不得晚于现在） */
  function validRecordBody(): {
    actualTime: string;
    mode: number;
    coreContent: string;
    followUp: string;
  } {
    return {
      actualTime: new Date(Date.now() - HOUR_MS).toISOString(),
      mode: 1,
      coreContent: '重填：围绕挑战杯选题重新梳理技术路线。',
      followUp: '重填：下次带原型演示。',
    };
  }

  async function createAppointment(
    overrides: Partial<Appointment> = {},
  ): Promise<Appointment> {
    return prisma.client.appointment.create({
      data: {
        studentPersonId: personId('S001'),
        mentorProfileId: profileOf('T001').id,
        type: 1,
        // 默认 5 DISPUTED：复核的合法出发态
        status: 5,
        requestedTime: new Date(Date.now() - 24 * HOUR_MS),
        topic: '挑战杯选题与打磨',
        questions: '如何把技术方案讲成一个好故事？',
        mode: 1,
        disputeReason: '记录中的实际指导时间与当天安排不符',
        createdBy: 0n,
        updatedBy: 0n,
        ...overrides,
      },
    });
  }

  async function createRecord(
    appointmentId: bigint,
    overrides: Partial<GuidanceRecord> = {},
  ): Promise<GuidanceRecord> {
    return prisma.client.guidanceRecord.create({
      data: {
        appointmentId,
        actualTime: new Date(Date.now() - 2 * HOUR_MS),
        mode: 1,
        coreContent: '首次填报的核心内容',
        followUp: '首次填报的后续建议',
        submittedBy: personId('T001'),
        submittedAt: new Date(Date.now() - HOUR_MS),
        createdBy: 0n,
        updatedBy: 0n,
        ...overrides,
      },
    });
  }

  async function appointmentRow(id: bigint): Promise<Appointment | null> {
    return prisma.client.appointment.findFirst({ where: { id } });
  }

  function expectFieldError(response: { body: unknown }, field: string): void {
    const data = response.body as ResponseEnvelope<{ fields: FieldErrorDto[] }>;
    expect(data.code).toBe(ErrorCode.PARAM_INVALID);
    expect(data.data.fields.some((f) => f.field === field)).toBe(true);
  }

  // ── adjudicate：uphold / return ─────────────────────────────────

  it('uphold：5 → 6 COMPLETED，comment 落 adjudicateComment，disputeReason 清空', async () => {
    const appointment = await createAppointment({ status: 5 });

    const response = await api('adminA')
      .post(`/appointments/${appointment.id}/adjudicate`)
      .send({ decision: 'uphold', comment: '经核对，异议成立。' })
      .expect(200);

    const data = (response.body as ResponseEnvelope<AppointmentResponseDto>)
      .data;
    expect(data.status).toBe(6);
    expect(data.adjudicateComment).toBe('经核对，异议成立。');
    expect(data.disputeReason).toBeNull();

    const row = await appointmentRow(appointment.id);
    expect(row?.status).toBe(6);
    expect(row?.adjudicateComment).toBe('经核对，异议成立。');
    expect(row?.disputeReason).toBeNull();
  });

  it('return：5 → 3 RECORD_SUBMITTED，disputeReason 仍非 null（R36）', async () => {
    const appointment = await createAppointment({
      status: 5,
      disputeReason: '记录时间与当天安排不符',
    });

    const response = await api('adminA')
      .post(`/appointments/${appointment.id}/adjudicate`)
      .send({ decision: 'return', comment: '退回导师重填。' })
      .expect(200);

    const data = (response.body as ResponseEnvelope<AppointmentResponseDto>)
      .data;
    expect(data.status).toBe(3);
    expect(data.disputeReason).toBe('记录时间与当天安排不符');
    expect(data.adjudicateComment).toBe('退回导师重填。');

    const row = await appointmentRow(appointment.id);
    expect(row?.status).toBe(3);
    expect(row?.disputeReason).toBe('记录时间与当天安排不符');
    expect(row?.adjudicateComment).toBe('退回导师重填。');
  });

  it('status 0 / 3 / 4 / 6 → 各 409 / 32003，且不落复核意见', async () => {
    for (const status of [0, 3, 4, 6]) {
      const appointment = await createAppointment({ status });
      const response = await api('adminA')
        .post(`/appointments/${appointment.id}/adjudicate`)
        .send({ decision: 'uphold', comment: '试图复核' })
        .expect(409);

      const data = response.body as ResponseEnvelope<null>;
      expect(data.code).toBe(ErrorCode.APPOINTMENT_TRANSITION_INVALID);
      expect(data.message).toBe('当前状态不允许该操作');

      const row = await appointmentRow(appointment.id);
      expect(row?.status).toBe(status);
      expect(row?.adjudicateComment).toBeNull();
    }
  });

  // ── adjudicate：数据范围 ────────────────────────────────────────

  it('外院管理员 → 403 / 10003（不是 404 / 32002），且不落复核意见', async () => {
    const appointment = await createAppointment({ status: 5 });

    const response = await api('adminB')
      .post(`/appointments/${appointment.id}/adjudicate`)
      .send({ decision: 'uphold', comment: '外院越权' })
      .expect(403);

    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.FORBIDDEN);
    expect(data.message).toBe('无权限');

    const row = await appointmentRow(appointment.id);
    expect(row?.status).toBe(5);
    expect(row?.adjudicateComment).toBeNull();
  });

  it('sc_admin（数据范围 all、部门挂根节点）可复核任一学院的单 → 200', async () => {
    // 需求 §4.3：预约复核是二级学院 / 双创学院管理员**共有**需求。这里对学院 A、
    // 学院 B 各造一条 5 态预约，sc_admin 都必须能复核（all clamp 到 dept 后覆盖全部学院）。
    for (const student of ['S001', 'S002'] as const) {
      const appointment = await createAppointment({
        status: 5,
        studentPersonId: personId(student),
      });

      const response = await api('scAdmin')
        .post(`/appointments/${appointment.id}/adjudicate`)
        .send({ decision: 'uphold', comment: `双创学院复核 ${student}` })
        .expect(200);

      const data = (response.body as ResponseEnvelope<AppointmentResponseDto>)
        .data;
      expect(data.status).toBe(6);
      expect(data.adjudicateComment).toBe(`双创学院复核 ${student}`);
    }
  });

  it('不存在的 :id → 404 / 32001', async () => {
    const response = await api('adminA')
      .post('/appointments/999999999/adjudicate')
      .send({ decision: 'uphold', comment: '不存在' })
      .expect(404);

    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.APPOINTMENT_NOT_FOUND);
    expect(data.message).toBe('预约不存在');
  });

  it('缺 appointment:adjudicate 的导师 → 403 / 10003（权限守卫先挡）', async () => {
    const appointment = await createAppointment({ status: 5 });

    const response = await api('T001')
      .post(`/appointments/${appointment.id}/adjudicate`)
      .send({ decision: 'uphold', comment: '导师越权' })
      .expect(403);

    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.FORBIDDEN);
    expect(data.message).toContain('appointment:adjudicate');
  });

  // ── adjudicate：参数校验 ────────────────────────────────────────

  it('decision 传其它值 → 400，点名 decision', async () => {
    const appointment = await createAppointment({ status: 5 });
    const response = await api('adminA')
      .post(`/appointments/${appointment.id}/adjudicate`)
      .send({ decision: 'approve', comment: '非法决定' })
      .expect(400);

    expectFieldError(response, 'decision');
  });

  it('comment 缺失 / 空串 / 501 字 → 各 400，点名 comment', async () => {
    const cases: Array<Record<string, unknown>> = [
      { decision: 'uphold' },
      { decision: 'uphold', comment: '' },
      { decision: 'uphold', comment: '字'.repeat(501) },
    ];
    for (const body of cases) {
      const appointment = await createAppointment({ status: 5 });
      const response = await api('adminA')
        .post(`/appointments/${appointment.id}/adjudicate`)
        .send(body)
        .expect(400);
      expectFieldError(response, 'comment');
    }
  });

  // ── R37：记录重填 ───────────────────────────────────────────────

  it('R37：status = 3 时导师 POST record → 更新同一行（行数仍 1、状态仍 3、内容变）', async () => {
    const appointment = await createAppointment({ status: 3 });
    const original = await createRecord(appointment.id);
    const before = Date.now();

    const response = await api('T001')
      .post(`/appointments/${appointment.id}/record`)
      .send(validRecordBody())
      .expect(201);

    const data = (response.body as ResponseEnvelope<GuidanceRecordResponseDto>)
      .data;
    expect(data.appointmentId).toBe(appointment.id.toString());
    expect(data.coreContent).toBe('重填：围绕挑战杯选题重新梳理技术路线。');
    expect(data.followUp).toBe('重填：下次带原型演示。');

    const records = await prisma.client.guidanceRecord.findMany({
      where: { appointmentId: appointment.id },
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe(original.id);
    expect(records[0]?.coreContent).toBe(
      '重填：围绕挑战杯选题重新梳理技术路线。',
    );
    expect(records[0]?.followUp).toBe('重填：下次带原型演示。');
    expect(records[0]?.submittedAt.getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );

    const row = await appointmentRow(appointment.id);
    expect(row?.status).toBe(3);
  });

  it('R37 不影响原行为：status = 1 时 POST record 仍建记录 + 1 → 3', async () => {
    const appointment = await createAppointment({ status: 1 });

    const response = await api('T001')
      .post(`/appointments/${appointment.id}/record`)
      .send(validRecordBody())
      .expect(201);

    const data = (response.body as ResponseEnvelope<GuidanceRecordResponseDto>)
      .data;
    expect(data.appointmentId).toBe(appointment.id.toString());

    const row = await appointmentRow(appointment.id);
    expect(row?.status).toBe(3);

    const records = await prisma.client.guidanceRecord.findMany({
      where: { appointmentId: appointment.id },
    });
    expect(records).toHaveLength(1);
  });

  it('R37 后学生仍可 confirm-record：3 → 4，disputeReason 清空', async () => {
    // 先走完整链路：5 →（退回）3 →（重填）3 →（学生确认）4
    const appointment = await createAppointment({
      status: 5,
      disputeReason: '记录时间不符',
    });
    await createRecord(appointment.id);

    await api('adminA')
      .post(`/appointments/${appointment.id}/adjudicate`)
      .send({ decision: 'return', comment: '退回重填' })
      .expect(200);

    await api('T001')
      .post(`/appointments/${appointment.id}/record`)
      .send(validRecordBody())
      .expect(201);

    const response = await api('S001')
      .post(`/appointments/${appointment.id}/confirm-record`)
      .expect(200);

    const data = (response.body as ResponseEnvelope<AppointmentResponseDto>)
      .data;
    expect(data.status).toBe(4);
    expect(data.disputeReason).toBeNull();

    const row = await appointmentRow(appointment.id);
    expect(row?.status).toBe(4);
    expect(row?.disputeReason).toBeNull();
  });

  it('R37 重填仍只许该预约的导师本人：别的导师 → 403 / 32002', async () => {
    const appointment = await createAppointment({ status: 3 });
    await createRecord(appointment.id);

    const response = await api('T002')
      .post(`/appointments/${appointment.id}/record`)
      .send(validRecordBody())
      .expect(403);

    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.APPOINTMENT_FORBIDDEN);
    expect(data.message).toBe('无权访问该预约');
  });

  // ── 并发双发 adjudicate：条件更新保证恰一次成功 ─────────────────

  it('并发双发 adjudicate → 恰 1×200 + 1×409 / 32003，跑 3 轮', async () => {
    for (let round = 0; round < 3; round += 1) {
      const appointment = await createAppointment({ status: 5 });
      const body = { decision: 'uphold', comment: `并发第 ${round + 1} 轮` };

      const [first, second] = await Promise.all([
        api('adminA')
          .post(`/appointments/${appointment.id}/adjudicate`)
          .send(body),
        api('adminA')
          .post(`/appointments/${appointment.id}/adjudicate`)
          .send(body),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);

      const loser = first.status === 409 ? first : second;
      const data = loser.body as ResponseEnvelope<null>;
      expect(data.code).toBe(ErrorCode.APPOINTMENT_TRANSITION_INVALID);
      expect(data.message).toBe('当前状态不允许该操作');

      const row = await appointmentRow(appointment.id);
      expect(row?.status).toBe(6);
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
