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
 * 指导记录填报 / 读取（e2e）—— Task 26 的全部判据。
 *
 * 共享库态、`maxWorkers: 1` 串行。每个用例**自建自己的预约行**（直接写库），
 * 因此用例之间没有执行顺序依赖：
 * - 学生 S001（`appointment:create` + `appointment:list`，**没有** `appointment:handle`）；
 * - 导师 T001（预约的导师本人，`appointment:handle` + `appointment:list`）；
 * - 导师 T002（同码，别的导师）；
 * - 学院 A / B 的管理员（`appointment:list`，`deptAndChildren`），用来钉
 *   「本院可见 / 外院 403」。
 *
 * docs:gen 的 57 路径 / 77 操作由门槛命令核；本套件钉两条记录路由的**行为**。
 */
describe('指导记录填报 / 读取 (e2e)', () => {
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

    const orgA = await createOrg('ORG-RECORD-A', '学院 A 组织', dept('A'));
    const orgB = await createOrg('ORG-RECORD-B', '学院 B 组织', dept('B'));
    // 无部门投影的组织：申请人 deptId 为空，GET 可见性必须 fail-closed（P2-3）
    const orgC = await createOrg('ORG-RECORD-C', '未投影组织', null);

    const identities: Array<[string, string, bigint]> = [
      ['S001', 'student', orgA],
      ['T001', 'internalMentor', orgA],
      ['T002', 'internalMentor', orgB],
      ['S002', 'student', orgC],
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
      '记录学生角色',
      'record_student',
      'self',
      ['appointment:create', 'appointment:list'],
    );
    const mentorRole = await createRoleWithCodes(
      '记录导师角色',
      'record_mentor',
      'self',
      ['appointment:handle', 'appointment:list'],
    );
    const collegeAdminRole = await createRoleWithCodes(
      '记录学院管理员角色',
      'record_college_admin',
      'deptAndChildren',
      ['appointment:list'],
    );

    const users: Array<[string, bigint, RoleResponseDto]> = [
      ['S001', dept('A'), studentRole],
      ['T001', dept('A'), mentorRole],
      ['T002', dept('B'), mentorRole],
      ['adminA', dept('A'), collegeAdminRole],
      ['adminB', dept('B'), collegeAdminRole],
    ];
    for (const [username, deptId, role] of users) {
      const user = await seedUser(prisma, { username, deptId });
      await linkUserRole(user.userId, BigInt(role.id));
    }

    for (const login of ['S001', 'T001', 'T002', 'adminA', 'adminB']) {
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

  /** 合法的填报请求体：actualTime 取一小时前（R35：不得晚于现在） */
  function validBody(): {
    actualTime: string;
    mode: number;
    coreContent: string;
    followUp: string;
  } {
    return {
      actualTime: new Date(Date.now() - HOUR_MS).toISOString(),
      mode: 1,
      coreContent: '围绕挑战杯选题梳理技术路线，确定主攻方向。',
      followUp: '下次带原型演示，重点讲清数据来源与评测口径。',
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
        // 默认 1 CONFIRMED：填报记录的合法出发态
        status: 1,
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

  async function createRecord(
    appointmentId: bigint,
    overrides: Partial<GuidanceRecord> = {},
  ): Promise<GuidanceRecord> {
    return prisma.client.guidanceRecord.create({
      data: {
        appointmentId,
        actualTime: new Date(Date.now() - 2 * HOUR_MS),
        mode: 1,
        coreContent: '核心指导内容',
        followUp: '后续指导建议',
        submittedBy: personId('T001'),
        submittedAt: new Date(Date.now() - HOUR_MS),
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

  // ── POST：1 → 3 ─────────────────────────────────────────────────

  it('POST：status 1 → 3，201，记录落库，submittedBy 是导师本人', async () => {
    const appointment = await createAppointment();
    const before = Date.now();

    const response = await api('T001')
      .post(`/appointments/${appointment.id}/record`)
      .send({
        actualTime: new Date(Date.now() - HOUR_MS).toISOString(),
        mode: 2,
        coreContent: '讲解了挑战杯选题与三条技术路线。',
        followUp: '下次带原型演示。',
      })
      .expect(201);

    const data = (response.body as ResponseEnvelope<GuidanceRecordResponseDto>)
      .data;
    expect(data).toMatchObject({
      appointmentId: appointment.id.toString(),
      mode: 2,
      coreContent: '讲解了挑战杯选题与三条技术路线。',
      followUp: '下次带原型演示。',
      submittedBy: personId('T001').toString(),
    });
    // R27：学生信息来自预约的 studentPersonId 联查
    expect(data.student).toMatchObject({ login: 'S001', realName: 'S001' });

    const appointmentRow = await prisma.client.appointment.findFirst({
      where: { id: appointment.id },
    });
    expect(appointmentRow?.status).toBe(3);

    const recordRow = await prisma.client.guidanceRecord.findFirst({
      where: { appointmentId: appointment.id },
    });
    expect(recordRow).not.toBeNull();
    expect(recordRow?.submittedBy).toBe(personId('T001'));
    expect(recordRow?.submittedAt.getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );
    expect(recordRow?.submittedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('POST 在 0 / 6 态、以及 3 态但记录不存在 → 各 409 / 32003，且不落记录', async () => {
    // Task 28 / R37：3 RECORD_SUBMITTED 本身已不是「非法出发态」——有记录时它是
    // **重填**（200）。这里跑的是 3 态**没有记录**的人为不一致，重填的 updateMany
    // 命中 0 行 → 仍然 409 / 32003（不建新记录）。
    for (const status of [0, 3, 6]) {
      const appointment = await createAppointment({ status });
      const response = await api('T001')
        .post(`/appointments/${appointment.id}/record`)
        .send(validBody())
        .expect(409);

      const data = response.body as ResponseEnvelope<null>;
      expect(data.code).toBe(ErrorCode.APPOINTMENT_TRANSITION_INVALID);
      expect(data.message).toBe('当前状态不允许该操作');

      const row = await prisma.client.appointment.findFirst({
        where: { id: appointment.id },
      });
      expect(row?.status).toBe(status);
      const records = await prisma.client.guidanceRecord.count({
        where: { appointmentId: appointment.id },
      });
      expect(records).toBe(0);
    }
  });

  it('别的导师 T002 调 POST → 403 / 32002', async () => {
    const appointment = await createAppointment();
    const response = await api('T002')
      .post(`/appointments/${appointment.id}/record`)
      .send(validBody())
      .expect(403);

    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.APPOINTMENT_FORBIDDEN);
    expect(data.message).toBe('无权访问该预约');
  });

  it('别人的、且 status = 6 的预约 → 403 / 32002（守卫 2 先于守卫 3，不是 32003）', async () => {
    // 预约属于 T001、已是终态 6；T002 来调。若守卫顺序反了会先撞状态给出
    // 32003，这里钉死「归属不符」必须赢（P2-1）。
    const appointment = await createAppointment({ status: 6 });
    const response = await api('T002')
      .post(`/appointments/${appointment.id}/record`)
      .send(validBody())
      .expect(403);

    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.APPOINTMENT_FORBIDDEN);
    expect(data.message).toBe('无权访问该预约');
  });

  it('不存在的 :id 调 POST → 404 / 32001', async () => {
    const response = await api('T001')
      .post('/appointments/999999999/record')
      .send(validBody())
      .expect(404);

    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.APPOINTMENT_NOT_FOUND);
    expect(data.message).toBe('预约不存在');
  });

  it('学生 S001 调 POST → 403 / 10003（缺 appointment:handle，权限守卫先挡）', async () => {
    const appointment = await createAppointment();
    const response = await api('S001')
      .post(`/appointments/${appointment.id}/record`)
      .send(validBody())
      .expect(403);

    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.FORBIDDEN);
    expect(data.message).toContain('appointment:handle');
  });

  it('重复提交（Task 28 / R37）→ 重填同一条记录，仍只有一条', async () => {
    // R37 之前这里期望 409；R37 明确「3 态再 POST = 重填」，所以第二次是更新
    // 而不是冲突。仍是唯一键下的同一行（行数 1），状态保持 3。
    const appointment = await createAppointment();
    const body = validBody();

    await api('T001')
      .post(`/appointments/${appointment.id}/record`)
      .send(body)
      .expect(201);

    const response = await api('T001')
      .post(`/appointments/${appointment.id}/record`)
      .send({ ...body, coreContent: '重填后的核心内容' })
      .expect(201);

    const data = (response.body as ResponseEnvelope<GuidanceRecordResponseDto>)
      .data;
    expect(data.coreContent).toBe('重填后的核心内容');

    const records = await prisma.client.guidanceRecord.findMany({
      where: { appointmentId: appointment.id },
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.coreContent).toBe('重填后的核心内容');

    const row = await prisma.client.appointment.findFirst({
      where: { id: appointment.id },
    });
    expect(row?.status).toBe(3);
  });

  // ── POST 参数校验 ────────────────────────────────────────────────

  it('actualTime 是未来时间 → 400，点名 actualTime', async () => {
    const appointment = await createAppointment();
    const response = await api('T001')
      .post(`/appointments/${appointment.id}/record`)
      .send({
        ...validBody(),
        actualTime: new Date(Date.now() + 60_000).toISOString(),
      })
      .expect(400);

    expectFieldError(response, 'actualTime');
  });

  it('mode 传 0 / 3 → 各 400，点名 mode', async () => {
    for (const mode of [0, 3]) {
      const appointment = await createAppointment();
      const response = await api('T001')
        .post(`/appointments/${appointment.id}/record`)
        .send({ ...validBody(), mode })
        .expect(400);
      expectFieldError(response, 'mode');
    }
  });

  it('coreContent 空 / 5001 字 → 各 400，点名 coreContent', async () => {
    for (const coreContent of ['', '字'.repeat(5001)]) {
      const appointment = await createAppointment();
      const response = await api('T001')
        .post(`/appointments/${appointment.id}/record`)
        .send({ ...validBody(), coreContent })
        .expect(400);
      expectFieldError(response, 'coreContent');
    }
  });

  it('followUp 空 / 2001 字 → 各 400，点名 followUp', async () => {
    for (const followUp of ['', '字'.repeat(2001)]) {
      const appointment = await createAppointment();
      const response = await api('T001')
        .post(`/appointments/${appointment.id}/record`)
        .send({ ...validBody(), followUp })
        .expect(400);
      expectFieldError(response, 'followUp');
    }
  });

  // ── P3 Task 35 / R58：指导时长 ──────────────────────────────────

  it('durationMinutes 不传 → 落 0，响应 0（语义是「未填」，不是「零分钟」）', async () => {
    const appointment = await createAppointment();

    const response = await api('T001')
      .post(`/appointments/${appointment.id}/record`)
      .send(validBody())
      .expect(201);

    const data = (response.body as ResponseEnvelope<GuidanceRecordResponseDto>)
      .data;
    expect(data.durationMinutes).toBe(0);

    const row = await prisma.client.guidanceRecord.findFirst({
      where: { appointmentId: appointment.id },
    });
    expect(row?.durationMinutes).toBe(0);
  });

  it('durationMinutes 传 60 → 落库 60 并原样回显', async () => {
    const appointment = await createAppointment();

    const response = await api('T001')
      .post(`/appointments/${appointment.id}/record`)
      .send({ ...validBody(), durationMinutes: 60 })
      .expect(201);

    const data = (response.body as ResponseEnvelope<GuidanceRecordResponseDto>)
      .data;
    expect(data.durationMinutes).toBe(60);

    const row = await prisma.client.guidanceRecord.findFirst({
      where: { appointmentId: appointment.id },
    });
    expect(row?.durationMinutes).toBe(60);
  });

  it('durationMinutes 传 0 / 601 → 各 400，点名 durationMinutes', async () => {
    // `0` 与「不传」是两种意思：不传 = 未填，传 0 = 填错了。静默当成未填会
    // 让「我明明填了 0 分钟」变成一条无法解释的数据。
    for (const durationMinutes of [0, 601]) {
      const appointment = await createAppointment();
      const response = await api('T001')
        .post(`/appointments/${appointment.id}/record`)
        .send({ ...validBody(), durationMinutes })
        .expect(400);
      expectFieldError(response, 'durationMinutes');
    }
  });

  // ── 并发双发：条件更新保证恰一次「建记录」 ──────────────────────

  it('并发双发首发（status=1）→ 恰 1×201 + 1×409 / 32003，库内恰 1 条记录、状态 3（3 轮）', async () => {
    // 两个请求几乎同时进守卫，都读到 1 CONFIRMED，都走「建记录 + 1→3」：
    // 条件更新 `where { id, status: 1 }` 只有一方命中，输家 `count = 0` → 409 / 32003。
    // （理论上若输家的守卫在赢家提交**之后**才读状态，它会读到 3 并转成重填、返回 201；
    // 实测 10 轮均为 [201, 409]，该路径由下一条「并发双发重填」用例确定性地覆盖。）
    for (let round = 0; round < 3; round += 1) {
      const appointment = await createAppointment();
      const body = validBody();

      const [first, second] = await Promise.all([
        api('T001').post(`/appointments/${appointment.id}/record`).send(body),
        api('T001').post(`/appointments/${appointment.id}/record`).send(body),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toEqual([201, 409]);

      const loser = first.status === 409 ? first : second;
      const data = loser.body as ResponseEnvelope<null>;
      expect(data.code).toBe(ErrorCode.APPOINTMENT_TRANSITION_INVALID);
      expect(data.message).toBe('当前状态不允许该操作');

      const records = await prisma.client.guidanceRecord.count({
        where: { appointmentId: appointment.id },
      });
      expect(records).toBe(1);

      const row = await prisma.client.appointment.findFirst({
        where: { id: appointment.id },
      });
      expect(row?.status).toBe(3);
    }
  });

  it('并发双发重填（status=3、记录已存在）→ 两个都 201，库内仍 1 条记录、状态仍 3（3 轮）', async () => {
    // R37 的重填路径不做状态迁移（`3 → 3`），两个请求都能命中条件更新：
    // 所以这里**两个都必须是 201**，且更新的是同一行（不能变成两条）。
    for (let round = 0; round < 3; round += 1) {
      const appointment = await createAppointment({ status: 3 });
      await createRecord(appointment.id);
      const body = {
        ...validBody(),
        coreContent: `并发重填第 ${round + 1} 轮`,
      };

      const [first, second] = await Promise.all([
        api('T001').post(`/appointments/${appointment.id}/record`).send(body),
        api('T001').post(`/appointments/${appointment.id}/record`).send(body),
      ]);

      expect([first.status, second.status]).toEqual([201, 201]);

      const records = await prisma.client.guidanceRecord.findMany({
        where: { appointmentId: appointment.id },
      });
      expect(records).toHaveLength(1);
      expect(records[0]?.coreContent).toBe(`并发重填第 ${round + 1} 轮`);

      const row = await prisma.client.appointment.findFirst({
        where: { id: appointment.id },
      });
      expect(row?.status).toBe(3);
    }
  });

  // ── GET：可见性 ─────────────────────────────────────────────────

  it('GET：申请人本人 / 导师本人 / 本院管理员 各 200，student 有值', async () => {
    const appointment = await createAppointment();
    await createRecord(appointment.id);

    for (const login of ['S001', 'T001', 'adminA']) {
      const response = await api(login)
        .get(`/appointments/${appointment.id}/record`)
        .expect(200);

      const data = (
        response.body as ResponseEnvelope<GuidanceRecordResponseDto>
      ).data;
      expect(data.appointmentId).toBe(appointment.id.toString());
      expect(data.student).toMatchObject({ login: 'S001', realName: 'S001' });
    }
  });

  it('GET：外院管理员 → 403 / 32002', async () => {
    const appointment = await createAppointment();
    await createRecord(appointment.id);

    const response = await api('adminB')
      .get(`/appointments/${appointment.id}/record`)
      .expect(403);

    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.APPOINTMENT_FORBIDDEN);
    expect(data.message).toBe('无权访问该预约');
  });

  it('GET：申请人没有部门投影（deptId 为空）→ 管理员 403 / 32002（fail-closed）', async () => {
    // S002 的组织行 deptId 为空：管理员的数据权限算不出「覆盖」，必须拒绝而不是
    // 当成「无限制」放行（P2-3）。
    const appointment = await createAppointment({
      studentPersonId: personId('S002'),
    });
    await createRecord(appointment.id);

    const response = await api('adminA')
      .get(`/appointments/${appointment.id}/record`)
      .expect(403);

    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.APPOINTMENT_FORBIDDEN);
    expect(data.message).toBe('无权访问该预约');
  });

  it('GET：还没填报时 → 404 / 33001', async () => {
    const appointment = await createAppointment();
    const response = await api('T001')
      .get(`/appointments/${appointment.id}/record`)
      .expect(404);

    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.GUIDANCE_RECORD_NOT_FOUND);
    expect(data.message).toBe('指导记录不存在');
  });
});

/**
 * 清预约域 + 同步层的残留（照 appointment-handle.e2e-spec.ts 的同名函数）。
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
