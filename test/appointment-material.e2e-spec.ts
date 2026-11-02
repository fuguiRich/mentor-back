import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type {
  Appointment,
  GuidanceRecord,
  MentorProfile,
  SyncPerson,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { buildDocument, configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { runWithSyncWrite } from '../src/infra/prisma/sync-write-scope';
import { ErrorCode } from '../src/common/constants/error-code';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import type { FileResponseDto } from '../src/modules/file/dto/file-response.dto';
import type { PermissionResponseDto } from '../src/modules/permission/dto/permission-response.dto';
import type { RoleResponseDto } from '../src/modules/role/dto/role-response.dto';
import type { AppointmentMaterialResponseDto } from '../src/modules/appointment/dto/appointment-material.dto';
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

/** 合法 PDF 头（魔数只看签名） */
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
/** 合法 PNG 头（8 字节签名） */
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

const SYNCED_AT = new Date('2026-10-27T00:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

/**
 * 预约材料 / 过程材料（Task 29）e2e —— brief 判据逐条落测。
 *
 * 共享库态、`maxWorkers: 1` 串行。每个用例**自建自己的预约行**（直接写库），
 * 因此用例之间没有执行顺序依赖：
 * - 学生 S001（`appointment:create` + `appointment:list` + `file:create`，
 *   **没有** `appointment:handle`）；
 * - 导师 T001（预约的导师本人，`appointment:handle` + `appointment:list` + `file:create`）；
 * - 导师 T002（同码，别的导师）；
 * - 学院 A / B 的管理员（`appointment:list`，`deptAndChildren`），钉「本院可见 / 外院 403」。
 *
 * 文件归属锚点：`ownerType = 'Appointment'`（**PascalCase、大小写敏感**）。
 *
 * docs:gen 的 65 路径 / 87 操作由门槛命令核；本套件钉 5 个操作的**行为**与
 * 4 条路径的形状。
 */
describe('预约材料 / 过程材料 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let root: string;
  let savedRoot: string | undefined;

  let adminApi: E2eApi;
  const agents = new Map<string, E2eApi>();
  const permissionIds = new Map<string, string>();
  const deptIds = new Map<string, bigint>();
  const people = new Map<string, SyncPerson>();
  const profiles = new Map<string, MentorProfile>();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'general-back-appt-material-e2e-'));
    savedRoot = process.env.FILE_ROOT;
    process.env.FILE_ROOT = root;

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

    const orgA = await createOrg('ORG-MAT-A', '学院 A 组织', dept('A'));
    const orgB = await createOrg('ORG-MAT-B', '学院 B 组织', dept('B'));
    // 无部门投影的组织：申请人 deptId 为空，GET 可见性必须 fail-closed
    const orgC = await createOrg('ORG-MAT-C', '未投影组织', null);

    const identities: Array<[string, string, bigint]> = [
      ['S001', 'student', orgA],
      ['S002', 'student', orgC],
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
      '材料学生角色',
      'mat_student',
      'self',
      ['appointment:create', 'appointment:list', 'file:create'],
    );
    const mentorRole = await createRoleWithCodes(
      '材料导师角色',
      'mat_mentor',
      'self',
      ['appointment:handle', 'appointment:list', 'file:create'],
    );
    const collegeAdminRole = await createRoleWithCodes(
      '材料学院管理员角色',
      'mat_college_admin',
      'deptAndChildren',
      ['appointment:list'],
    );

    const users: Array<[string, bigint, RoleResponseDto]> = [
      ['S001', dept('A'), studentRole],
      ['S002', dept('A'), studentRole],
      ['T001', dept('A'), mentorRole],
      ['T002', dept('B'), mentorRole],
      ['adminA', dept('A'), collegeAdminRole],
      ['adminB', dept('B'), collegeAdminRole],
    ];
    for (const [username, deptId, role] of users) {
      const user = await seedUser(prisma, { username, deptId });
      await linkUserRole(user.userId, BigInt(role.id));
    }

    for (const login of ['S001', 'S002', 'T001', 'T002', 'adminA', 'adminB']) {
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
      if (savedRoot === undefined) {
        delete process.env.FILE_ROOT;
      } else {
        process.env.FILE_ROOT = savedRoot;
      }
      if (root !== undefined) {
        await rm(root, { recursive: true, force: true });
      }
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

  /**
   * 上传一个文件。给了 owner 就带成对的 ownerType / ownerId——材料面依赖文件
   * 归属，归属不符必须落 404 / 28101。
   */
  async function upload(
    login: string,
    name: string,
    content: Buffer,
    owner?: { type: string; id: bigint },
  ): Promise<FileResponseDto> {
    let req = api(login).post('/files').attach('files', content, {
      filename: name,
      contentType: 'application/octet-stream',
    });
    if (owner !== undefined) {
      req = req
        .field('ownerType', owner.type)
        .field('ownerId', owner.id.toString());
    }
    const response = await req.expect(201);
    return (response.body as ResponseEnvelope<FileResponseDto[]>).data[0];
  }

  function errBody(response: { body: unknown }): ResponseEnvelope<null> {
    return response.body as ResponseEnvelope<null>;
  }

  // ── 判据 1：学生挂预约材料 → 201，AppointmentMaterial 一行 ──────────

  it('判据 1：学生挂预约材料 → 201，AppointmentMaterial 一行，source=appointment', async () => {
    const appointment = await createAppointment();
    const file = await upload('S001', '项目计划书.pdf', PDF, {
      type: 'Appointment',
      id: appointment.id,
    });

    const response = await api('S001')
      .post(`/appointments/${appointment.id}/materials`)
      .send({ fileId: file.id, kind: 1 })
      .expect(201);

    const data = (
      response.body as ResponseEnvelope<AppointmentMaterialResponseDto>
    ).data;
    expect(data).toMatchObject({
      source: 'appointment',
      fileId: file.id,
      kind: 1,
      originName: '项目计划书.pdf',
      mimeType: 'application/pdf',
      size: PDF.length,
    });
    expect(typeof data.createdAt).toBe('string');

    const rows = await prisma.client.appointmentMaterial.findMany({
      where: { appointmentId: appointment.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fileId).toBe(BigInt(file.id));
    expect(rows[0]?.kind).toBe(1);
  });

  // ── 判据 1b：kind 必填 / 只接受 1-3（R39 加列后的真实校验）─────────

  it('判据 1b：kind 缺失或越界 → 400 / 10001，点名 kind；合法值 1-3 落库', async () => {
    const appointment = await createAppointment();
    const file = await upload('S001', '分类校验.pdf', PDF, {
      type: 'Appointment',
      id: appointment.id,
    });

    const missing = await api('S001')
      .post(`/appointments/${appointment.id}/materials`)
      .send({ fileId: file.id })
      .expect(400);
    expect(errBody(missing).code).toBe(ErrorCode.PARAM_INVALID);

    const invalid = await api('S001')
      .post(`/appointments/${appointment.id}/materials`)
      .send({ fileId: file.id, kind: 4 })
      .expect(400);
    expect(errBody(invalid).code).toBe(ErrorCode.PARAM_INVALID);

    for (const kind of [1, 2, 3]) {
      const created = await api('S001')
        .post(`/appointments/${appointment.id}/materials`)
        .send({ fileId: file.id, kind })
        .expect(201);
      expect(
        (created.body as ResponseEnvelope<AppointmentMaterialResponseDto>).data
          .kind,
      ).toBe(kind);
      const row = await prisma.client.appointmentMaterial.findFirst({
        where: {
          appointmentId: appointment.id,
          fileId: BigInt(file.id),
        },
      });
      expect(row?.kind).toBe(kind);
      await api('S001')
        .delete(`/appointments/${appointment.id}/materials/${row?.id}`)
        .expect(200);
    }
  });

  // ── 判据 2：终态 6/7/8/9 不许挂 → 各 409 / 32003 ────────────────────

  it('判据 2：学生挂材料在 6 / 7 / 8 / 9 态 → 各 409 / 32003，无行落库', async () => {
    for (const status of [6, 7, 8, 9]) {
      const appointment = await createAppointment({ status });
      const file = await upload('S001', `终态-${status}.pdf`, PDF, {
        type: 'Appointment',
        id: appointment.id,
      });

      const response = await api('S001')
        .post(`/appointments/${appointment.id}/materials`)
        .send({ fileId: file.id, kind: 1 })
        .expect(409);
      const body = errBody(response);
      expect(body.code).toBe(ErrorCode.APPOINTMENT_TRANSITION_INVALID);
      expect(body.message).toBe('当前状态不允许该操作');

      const count = await prisma.client.appointmentMaterial.count({
        where: { appointmentId: appointment.id },
      });
      expect(count).toBe(0);
    }
  });

  // ── 判据 3：导师挂过程材料（记录已存在）→ 201，GuidanceMaterial 一行 ──

  it('判据 3：导师挂过程材料（记录已存在）→ 201，GuidanceMaterial 一行，source=record', async () => {
    const appointment = await createAppointment({ status: 3 });
    const record = await createRecord(appointment.id);
    const file = await upload('T001', '课件.pdf', PDF, {
      type: 'Appointment',
      id: appointment.id,
    });

    const response = await api('T001')
      .post(`/appointments/${appointment.id}/record/materials`)
      .send({ fileId: file.id })
      .expect(201);

    const data = (
      response.body as ResponseEnvelope<AppointmentMaterialResponseDto>
    ).data;
    expect(data).toMatchObject({
      source: 'record',
      fileId: file.id,
      kind: null,
      originName: '课件.pdf',
      mimeType: 'application/pdf',
    });

    const rows = await prisma.client.guidanceMaterial.findMany({
      where: { recordId: record.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fileId).toBe(BigInt(file.id));

    // 过程材料不分类：多传 kind 直接 400（收下再丢弃就是假接口，R39）
    const withKind = await api('T001')
      .post(`/appointments/${appointment.id}/record/materials`)
      .send({ fileId: file.id, kind: 1 })
      .expect(400);
    expect(errBody(withKind).code).toBe(ErrorCode.PARAM_INVALID);
  });

  // ── 判据 4：导师在 0 / 1 态挂过程材料 → 409 / 32003（记录还不存在）──

  it('判据 4：导师在 0 / 1 态挂过程材料 → 各 409 / 32003，无行落库', async () => {
    for (const status of [0, 1]) {
      const appointment = await createAppointment({ status });
      const file = await upload('T001', `未填记录-${status}.pdf`, PDF, {
        type: 'Appointment',
        id: appointment.id,
      });

      const response = await api('T001')
        .post(`/appointments/${appointment.id}/record/materials`)
        .send({ fileId: file.id })
        .expect(409);
      const body = errBody(response);
      expect(body.code).toBe(ErrorCode.APPOINTMENT_TRANSITION_INVALID);
      expect(body.message).toBe('当前状态不允许该操作');

      const count = await prisma.client.guidanceMaterial.count({
        where: { fileId: BigInt(file.id) },
      });
      expect(count).toBe(0);
    }
  });

  // ── 判据 5：归属不符 → 404 / 28101 ────────────────────────────────

  it('判据 5：把别的预约的文件挂到本预约 → 404 / 28101，无行落库', async () => {
    const target = await createAppointment();
    const other = await createAppointment();
    const file = await upload('S001', '别人的预约.pdf', PDF, {
      type: 'Appointment',
      id: other.id,
    });

    const response = await api('S001')
      .post(`/appointments/${target.id}/materials`)
      .send({ fileId: file.id, kind: 1 })
      .expect(404);
    const body = errBody(response);
    expect(body.code).toBe(ErrorCode.FILE_NOT_FOUND);
    expect(body.message).toBe('文件不存在');

    const count = await prisma.client.appointmentMaterial.count({
      where: { appointmentId: target.id },
    });
    expect(count).toBe(0);
  });

  // ── 判据 6：ownerType 写成小写 → 404 / 28101（钉死 'Appointment'）────

  it("判据 6：ownerType 写成 'mentorApplication'（小写）→ 挂接 404 / 28101", async () => {
    const appointment = await createAppointment();
    const file = await upload('S001', '小写归属.pdf', PDF, {
      type: 'mentorApplication',
      id: appointment.id,
    });

    const response = await api('S001')
      .post(`/appointments/${appointment.id}/materials`)
      .send({ fileId: file.id, kind: 1 })
      .expect(404);
    const body = errBody(response);
    expect(body.code).toBe(ErrorCode.FILE_NOT_FOUND);
    expect(body.message).toBe('文件不存在');

    const count = await prisma.client.appointmentMaterial.count({
      where: { appointmentId: appointment.id },
    });
    expect(count).toBe(0);
  });

  // ── 判据 7：同一 fileId 重复挂 → 409 / 32006 ──────────────────────

  it('判据 7：同一 fileId 重复挂 → 第二次 409 / 32006', async () => {
    const appointment = await createAppointment();
    const file = await upload('S001', '重复.pdf', PDF, {
      type: 'Appointment',
      id: appointment.id,
    });

    await api('S001')
      .post(`/appointments/${appointment.id}/materials`)
      .send({ fileId: file.id, kind: 1 })
      .expect(201);

    const response = await api('S001')
      .post(`/appointments/${appointment.id}/materials`)
      .send({ fileId: file.id, kind: 1 })
      .expect(409);
    const body = errBody(response);
    expect(body.code).toBe(ErrorCode.APPOINTMENT_MATERIAL_DUPLICATE);
    expect(body.message).toBe('该材料已挂接');

    const count = await prisma.client.appointmentMaterial.count({
      where: { appointmentId: appointment.id, fileId: BigInt(file.id) },
    });
    expect(count).toBe(1);
  });

  // ── 判据 8：GET 返回两类，source 区分正确 ─────────────────────────

  it('判据 8：GET 返回两类材料，source 字段区分正确（预约在前、过程在后）', async () => {
    const appointment = await createAppointment({ status: 3 });
    const record = await createRecord(appointment.id);
    const appointmentFile = await upload('S001', '预约材料.png', PNG, {
      type: 'Appointment',
      id: appointment.id,
    });
    const recordFile = await upload('T001', '过程材料.pdf', PDF, {
      type: 'Appointment',
      id: appointment.id,
    });

    await api('S001')
      .post(`/appointments/${appointment.id}/materials`)
      .send({ fileId: appointmentFile.id, kind: 1 })
      .expect(201);
    await api('T001')
      .post(`/appointments/${appointment.id}/record/materials`)
      .send({ fileId: recordFile.id })
      .expect(201);

    const response = await api('S001')
      .get(`/appointments/${appointment.id}/materials`)
      .expect(200);
    const data = (
      response.body as ResponseEnvelope<{
        list: AppointmentMaterialResponseDto[];
        total: number;
        page: number;
        pageSize: number;
      }>
    ).data;

    expect(data.total).toBe(2);
    expect(data.page).toBe(1);
    expect(data.pageSize).toBe(2);
    expect(data.list.map((item) => item.source)).toEqual([
      'appointment',
      'record',
    ]);
    expect(data.list[0]).toMatchObject({
      fileId: appointmentFile.id,
      originName: '预约材料.png',
      mimeType: 'image/png',
      kind: 1,
    });
    expect(data.list[1]).toMatchObject({
      fileId: recordFile.id,
      originName: '过程材料.pdf',
      kind: null,
    });
    // 过程材料来自 GuidanceMaterial 表，不是 AppointmentMaterial
    expect(
      await prisma.client.guidanceMaterial.count({
        where: { recordId: record.id },
      }),
    ).toBe(1);
  });

  // ── 判据 9：GET 外院管理员 → 403 / 32002 ──────────────────────────

  it('判据 9：GET 外院管理员 → 403 / 32002（本院管理员可见）', async () => {
    const appointment = await createAppointment();
    await upload('S001', '可见性.pdf', PDF, {
      type: 'Appointment',
      id: appointment.id,
    });

    // 本院管理员：申请人 S001 在学院 A，adminA 的 deptAndChildren 覆盖 → 200
    await api('adminA')
      .get(`/appointments/${appointment.id}/materials`)
      .expect(200);

    // 外院管理员 adminB（学院 B）→ 403 / 32002
    const response = await api('adminB')
      .get(`/appointments/${appointment.id}/materials`)
      .expect(403);
    const body = errBody(response);
    expect(body.code).toBe(ErrorCode.APPOINTMENT_FORBIDDEN);
    expect(body.message).toBe('无权访问该预约');
  });

  // ── 判据 10：DELETE 预约材料（申请人）→ 200，SysFile 仍在 ──────────

  it('判据 10：DELETE 预约材料（申请人）→ 200，列表不再出现，SysFile 行仍在', async () => {
    const appointment = await createAppointment();
    const file = await upload('S001', '待摘.pdf', PDF, {
      type: 'Appointment',
      id: appointment.id,
    });
    const created = await api('S001')
      .post(`/appointments/${appointment.id}/materials`)
      .send({ fileId: file.id, kind: 1 })
      .expect(201);
    const materialId = (
      created.body as ResponseEnvelope<AppointmentMaterialResponseDto>
    ).data.id;

    const response = await api('S001')
      .delete(`/appointments/${appointment.id}/materials/${materialId}`)
      .expect(200);
    expect(
      (response.body as ResponseEnvelope<{ id: string; source: string }>).data,
    ).toMatchObject({ id: materialId, source: 'appointment' });

    const listed = await api('S001')
      .get(`/appointments/${appointment.id}/materials`)
      .expect(200);
    expect(
      (
        listed.body as ResponseEnvelope<{
          list: AppointmentMaterialResponseDto[];
        }>
      ).data.list,
    ).toHaveLength(0);

    // 软删生效：行还在（deletedAt 非空），SysFile 一行未动
    const row = await prisma.includingDeleted.appointmentMaterial.findFirst({
      where: { id: BigInt(materialId) },
    });
    expect(row?.deletedAt).not.toBeNull();
    const sysFile = await prisma.client.sysFile.findFirst({
      where: { id: BigInt(file.id) },
    });
    expect(sysFile).not.toBeNull();
  });

  // ── 判据 11：DELETE 过程材料（导师 200 / 学生 403 / 10003）──────────

  it('判据 11：学生删过程材料 → 403 / 10003；导师删 → 200', async () => {
    const appointment = await createAppointment({ status: 3 });
    await createRecord(appointment.id);
    const file = await upload('T001', '过程材料待摘.pdf', PDF, {
      type: 'Appointment',
      id: appointment.id,
    });
    const created = await api('T001')
      .post(`/appointments/${appointment.id}/record/materials`)
      .send({ fileId: file.id })
      .expect(201);
    const materialId = (
      created.body as ResponseEnvelope<AppointmentMaterialResponseDto>
    ).data.id;

    // 学生 S001 有 appointment:create，但没有 appointment:handle——
    // 权限守卫（控制器上声明）在第一道闸就挡下
    const denied = await api('S001')
      .delete(`/appointments/${appointment.id}/record/materials/${materialId}`)
      .expect(403);
    const deniedBody = errBody(denied);
    expect(deniedBody.code).toBe(ErrorCode.FORBIDDEN);
    expect(deniedBody.message).toContain('appointment:handle');

    // 导师本人删除 → 200
    const removed = await api('T001')
      .delete(`/appointments/${appointment.id}/record/materials/${materialId}`)
      .expect(200);
    expect(
      (removed.body as ResponseEnvelope<{ id: string; source: string }>).data,
    ).toMatchObject({ id: materialId, source: 'record' });

    const listed = await api('T001')
      .get(`/appointments/${appointment.id}/materials`)
      .expect(200);
    expect(
      (
        listed.body as ResponseEnvelope<{
          list: AppointmentMaterialResponseDto[];
        }>
      ).data.list,
    ).toHaveLength(0);
  });

  // ── 判据 12：:materialId 不存在 / 已软删 → 404 / 32005 ────────────

  it('判据 12：:materialId 不存在 / 已软删 → 404 / 32005', async () => {
    const appointment = await createAppointment();

    // 不存在
    const missing = await api('S001')
      .delete(`/appointments/${appointment.id}/materials/999999999`)
      .expect(404);
    expect(errBody(missing).code).toBe(
      ErrorCode.APPOINTMENT_MATERIAL_NOT_FOUND,
    );
    expect(errBody(missing).message).toBe('预约材料不存在');

    // 已软删：先挂、再摘、再摘一次
    const file = await upload('S001', '摘两次.pdf', PDF, {
      type: 'Appointment',
      id: appointment.id,
    });
    const created = await api('S001')
      .post(`/appointments/${appointment.id}/materials`)
      .send({ fileId: file.id, kind: 1 })
      .expect(201);
    const materialId = (
      created.body as ResponseEnvelope<AppointmentMaterialResponseDto>
    ).data.id;
    await api('S001')
      .delete(`/appointments/${appointment.id}/materials/${materialId}`)
      .expect(200);

    const again = await api('S001')
      .delete(`/appointments/${appointment.id}/materials/${materialId}`)
      .expect(404);
    expect(errBody(again).code).toBe(ErrorCode.APPOINTMENT_MATERIAL_NOT_FOUND);
  });

  // ── 判据 13：摘掉后同一 fileId 可再挂 → 201 ───────────────────────

  it('判据 13：摘掉后同一 fileId 可再挂 → 201', async () => {
    const appointment = await createAppointment();
    const file = await upload('S001', '再挂一次.pdf', PDF, {
      type: 'Appointment',
      id: appointment.id,
    });

    const first = await api('S001')
      .post(`/appointments/${appointment.id}/materials`)
      .send({ fileId: file.id, kind: 1 })
      .expect(201);
    const materialId = (
      first.body as ResponseEnvelope<AppointmentMaterialResponseDto>
    ).data.id;

    await api('S001')
      .delete(`/appointments/${appointment.id}/materials/${materialId}`)
      .expect(200);

    const second = await api('S001')
      .post(`/appointments/${appointment.id}/materials`)
      .send({ fileId: file.id, kind: 2 })
      .expect(201);
    expect(
      (second.body as ResponseEnvelope<AppointmentMaterialResponseDto>).data,
    ).toMatchObject({ source: 'appointment', fileId: file.id });

    const active = await prisma.client.appointmentMaterial.count({
      where: { appointmentId: appointment.id, fileId: BigInt(file.id) },
    });
    expect(active).toBe(1);
  });

  // ── 判据 14：材料面恰好 4 条路径 / 5 个操作 ────────────────────────

  it('判据 14：材料面恰好 4 条路径 / 5 个操作（docs:gen 总数由门槛命令核）', () => {
    const document = buildDocument(app);
    const paths = document.paths as Record<string, Record<string, unknown>>;
    const materialPaths = Object.keys(paths).filter(
      (path) =>
        path === '/appointments/{id}/materials' ||
        path === '/appointments/{id}/record/materials' ||
        path === '/appointments/{id}/materials/{materialId}' ||
        path === '/appointments/{id}/record/materials/{materialId}',
    );
    expect(materialPaths.sort()).toEqual([
      '/appointments/{id}/materials',
      '/appointments/{id}/materials/{materialId}',
      '/appointments/{id}/record/materials',
      '/appointments/{id}/record/materials/{materialId}',
    ]);
    const operations = materialPaths.reduce(
      (sum, path) =>
        sum +
        Object.keys(paths[path]).filter((key) =>
          ['get', 'post', 'put', 'delete', 'patch'].includes(key),
        ).length,
      0,
    );
    expect(operations).toBe(5);
  });

  // ── 判据 15（返工轮 1 / F1）：预约侧 DELETE 的权限码有测试兜底 ──────

  it('判据 15：无 appointment:create 的账号删预约材料 → 403 / 10003', async () => {
    const appointment = await createAppointment();
    const file = await upload('S001', '权限码兜底.pdf', PDF, {
      type: 'Appointment',
      id: appointment.id,
    });
    const created = await api('S001')
      .post(`/appointments/${appointment.id}/materials`)
      .send({ fileId: file.id, kind: 1 })
      .expect(201);
    const materialId = (
      created.body as ResponseEnvelope<AppointmentMaterialResponseDto>
    ).data.id;

    // T001 有 appointment:handle / appointment:list，**没有** appointment:create——
    // 权限守卫（控制器上声明）必须在第一道闸就挡下
    const denied = await api('T001')
      .delete(`/appointments/${appointment.id}/materials/${materialId}`)
      .expect(403);
    const deniedBody = errBody(denied);
    expect(deniedBody.code).toBe(ErrorCode.FORBIDDEN);
    expect(deniedBody.message).toContain('appointment:create');

    // 权限守卫挡在服务层之前，没有副作用：材料仍在
    expect(
      await prisma.client.appointmentMaterial.count({
        where: { id: BigInt(materialId) },
      }),
    ).toBe(1);

    // 申请人本人仍可摘 → 200
    await api('S001')
      .delete(`/appointments/${appointment.id}/materials/${materialId}`)
      .expect(200);
  });

  // ── 判据 16（返工轮 1 / F2）：过程材料重复挂 → 409 / 32006 ──────────

  it('判据 16：过程材料同一 fileId 重复挂 → 第二次 409 / 32006', async () => {
    const appointment = await createAppointment({ status: 3 });
    const record = await createRecord(appointment.id);
    const file = await upload('T001', '过程重复.pdf', PDF, {
      type: 'Appointment',
      id: appointment.id,
    });

    await api('T001')
      .post(`/appointments/${appointment.id}/record/materials`)
      .send({ fileId: file.id })
      .expect(201);

    const response = await api('T001')
      .post(`/appointments/${appointment.id}/record/materials`)
      .send({ fileId: file.id })
      .expect(409);
    const body = errBody(response);
    expect(body.code).toBe(ErrorCode.APPOINTMENT_MATERIAL_DUPLICATE);
    expect(body.message).toBe('该材料已挂接');

    expect(
      await prisma.client.guidanceMaterial.count({
        where: { recordId: record.id, fileId: BigInt(file.id) },
      }),
    ).toBe(1);
  });

  // ── 判据 17（返工轮 1 / F2）：并发双发恰一行落库 ────────────────────

  it('判据 17：并发双发同一挂接 → 恰一行落库，一个 201 一个 409 / 32006', async () => {
    const appointment = await createAppointment();
    const file = await upload('S001', '并发.pdf', PDF, {
      type: 'Appointment',
      id: appointment.id,
    });

    const [first, second] = await Promise.all([
      api('S001')
        .post(`/appointments/${appointment.id}/materials`)
        .send({ fileId: file.id, kind: 1 }),
      api('S001')
        .post(`/appointments/${appointment.id}/materials`)
        .send({ fileId: file.id, kind: 1 }),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const conflict = [first, second].find(
      (response) => response.status === 409,
    );
    if (conflict === undefined) {
      throw new Error('并发双发没有出现 409');
    }
    expect(errBody(conflict).code).toBe(
      ErrorCode.APPOINTMENT_MATERIAL_DUPLICATE,
    );

    expect(
      await prisma.client.appointmentMaterial.count({
        where: { appointmentId: appointment.id, fileId: BigInt(file.id) },
      }),
    ).toBe(1);
  });

  // ── 判据 18（返工轮 1 / F2）：DB-11 生成列唯一键兜底 ─────────────────

  it('判据 18：两表生成列唯一键拒绝重复未删行，软删后同 fileId 可再挂', async () => {
    const appointment = await createAppointment();
    const fileId = 987654321n;
    const appointmentData = {
      appointmentId: appointment.id,
      fileId,
      kind: 1,
      createdBy: 0n,
      updatedBy: 0n,
    };

    const first = await prisma.client.appointmentMaterial.create({
      data: appointmentData,
    });
    await expect(
      prisma.client.appointmentMaterial.create({ data: appointmentData }),
    ).rejects.toMatchObject({ code: 'P2002' });

    // 软删行的生成列取 NULL → 不占位，同一 fileId 可再挂
    await prisma.client.appointmentMaterial.update({
      where: { id: first.id },
      data: { deletedAt: new Date(), deletedBy: 0n },
    });
    const afterDelete = await prisma.client.appointmentMaterial.create({
      data: appointmentData,
    });
    expect(afterDelete.id).not.toBe(first.id);

    const recordAppointment = await createAppointment({ status: 3 });
    const record = await createRecord(recordAppointment.id);
    const recordData = {
      recordId: record.id,
      fileId,
      createdBy: 0n,
      updatedBy: 0n,
    };

    const firstRecord = await prisma.client.guidanceMaterial.create({
      data: recordData,
    });
    await expect(
      prisma.client.guidanceMaterial.create({ data: recordData }),
    ).rejects.toMatchObject({ code: 'P2002' });

    await prisma.client.guidanceMaterial.update({
      where: { id: firstRecord.id },
      data: { deletedAt: new Date(), deletedBy: 0n },
    });
    const afterRecordDelete = await prisma.client.guidanceMaterial.create({
      data: recordData,
    });
    expect(afterRecordDelete.id).not.toBe(firstRecord.id);
  });

  // ── 判据 19（返工轮 1 / F3）：过程材料 404 用自己的码与文案 ──────────

  it('判据 19：过程材料 :materialId 不存在 / 已软删 → 404 / 33002「过程材料不存在」', async () => {
    const appointment = await createAppointment({ status: 3 });
    await createRecord(appointment.id);

    const missing = await api('T001')
      .delete(`/appointments/${appointment.id}/record/materials/999999999`)
      .expect(404);
    expect(errBody(missing).code).toBe(ErrorCode.GUIDANCE_MATERIAL_NOT_FOUND);
    expect(errBody(missing).message).toBe('过程材料不存在');

    const file = await upload('T001', '过程摘两次.pdf', PDF, {
      type: 'Appointment',
      id: appointment.id,
    });
    const created = await api('T001')
      .post(`/appointments/${appointment.id}/record/materials`)
      .send({ fileId: file.id })
      .expect(201);
    const materialId = (
      created.body as ResponseEnvelope<AppointmentMaterialResponseDto>
    ).data.id;

    await api('T001')
      .delete(`/appointments/${appointment.id}/record/materials/${materialId}`)
      .expect(200);

    const again = await api('T001')
      .delete(`/appointments/${appointment.id}/record/materials/${materialId}`)
      .expect(404);
    expect(errBody(again).code).toBe(ErrorCode.GUIDANCE_MATERIAL_NOT_FOUND);
    expect(errBody(again).message).toBe('过程材料不存在');
  });
});

/** 清预约域 + 同步层残留（照 appointment-record.e2e-spec.ts 的同名函数） */
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
