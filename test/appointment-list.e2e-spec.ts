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
import type {
  AppointmentDetailDto,
  AppointmentListResponseDto,
} from '../src/modules/appointment/dto/appointment-list.dto';
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

/** 造一条同步人员（`SyncPerson` 只能走 `runWithSyncWrite` 写） */
interface PersonSeed {
  login: string;
  personType: string;
  orgUnitId: bigint;
  major?: string;
  className?: string;
  mobile?: string;
}

/**
 * 预约列表与详情（e2e）—— Task 30 的全部判据。
 *
 * 共享库态、`maxWorkers: 1` 串行。**执行顺序即判据顺序**：前两组用例断言
 * 「恰好几条」，靠的是它们跑在任何造数之前——基础数据集只有 3 条预约
 * （S_A→T_X、S_B→T_X、S_B→T_Y）。之后的用例各自用**专属学生**造数
 * （S_P 分页 25 条 / S_F 状态过滤 / S_O 同毫秒排序），互不污染。判据 4 另在
 * 判据 9 之后给 S_P 补两条钉了不同 createdAt 的行，用来钉主序倒序（此后不再
 * 断言 S_P 的条数）。
 *
 * 角色与数据范围：
 * - S_A / S_B / S_P / S_F / S_O：学生，`self`（只看自己发起的）；
 * - T_X / T_Y：导师，`self`（只看约自己的）；
 * - adminA / adminB：学院管理员，`deptAndChildren`（按**申请人部门**收窄）；
 * - 超管：`all`（不加约束）；
 * - noPerm：无任何角色（`appointment:list` 缺码 → 403 / 10003）。
 *
 * docs:gen 的路径 / 操作总数由门槛命令核；本套件钉列表与详情两条路由的**行为**。
 */
describe('预约列表与详情 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;

  let adminApi: E2eApi;
  const agents = new Map<string, E2eApi>();
  const permissionIds = new Map<string, string>();
  const deptIds = new Map<string, bigint>();
  const people = new Map<string, SyncPerson>();
  const profiles = new Map<string, MentorProfile>();
  const baseAppointments = new Map<string, Appointment>();

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
    agents.set('admin', adminApi);

    const rootDept = await prisma.client.sysDept.findFirst({
      where: { name: '总公司' },
    });
    if (rootDept === null) {
      throw new Error('seedSuperAdmin 未种出「总公司」部门');
    }
    deptIds.set('A', await createDept('学院 A', rootDept.id));
    deptIds.set('B', await createDept('学院 B', rootDept.id));

    const orgA = await createOrg('ORG-LIST-A', '学院 A 组织', dept('A'));
    const orgB = await createOrg('ORG-LIST-B', '学院 B 组织', dept('B'));

    const identities: PersonSeed[] = [
      {
        login: 'S_A',
        personType: 'student',
        orgUnitId: orgA,
        major: '软件工程',
        className: '软工 2023-1 班',
        mobile: '13800000000',
      },
      { login: 'S_B', personType: 'student', orgUnitId: orgB },
      { login: 'S_P', personType: 'student', orgUnitId: orgA },
      { login: 'S_F', personType: 'student', orgUnitId: orgA },
      { login: 'S_O', personType: 'student', orgUnitId: orgA },
      { login: 'T_X', personType: 'internalMentor', orgUnitId: orgA },
      { login: 'T_Y', personType: 'internalMentor', orgUnitId: orgB },
      { login: 'T_Z', personType: 'internalMentor', orgUnitId: orgA },
    ];
    for (const seed of identities) {
      const person = await runWithSyncWrite(() =>
        prisma.client.syncPerson.create({
          data: {
            login: seed.login,
            realName: `${seed.login}-姓名`,
            personType: seed.personType,
            orgUnitId: seed.orgUnitId,
            major: seed.major ?? null,
            className: seed.className ?? null,
            mobile: seed.mobile ?? null,
            syncedAt: SYNCED_AT,
            createdBy: 0n,
            updatedBy: 0n,
          },
        }),
      );
      people.set(seed.login, person);
    }

    const studentRole = await createRoleWithCodes(
      '列表学生角色',
      'list_student',
      'self',
      ['appointment:list'],
    );
    const mentorRole = await createRoleWithCodes(
      '列表导师角色',
      'list_mentor',
      'self',
      ['appointment:list'],
    );
    const collegeAdminRole = await createRoleWithCodes(
      '列表学院管理员角色',
      'list_college_admin',
      'deptAndChildren',
      ['appointment:list'],
    );

    const users: Array<[string, bigint, RoleResponseDto | null]> = [
      ['S_A', dept('A'), studentRole],
      ['S_B', dept('B'), studentRole],
      ['S_P', dept('A'), studentRole],
      ['S_F', dept('A'), studentRole],
      ['S_O', dept('A'), studentRole],
      ['T_X', dept('A'), mentorRole],
      ['T_Y', dept('B'), mentorRole],
      ['adminA', dept('A'), collegeAdminRole],
      ['adminB', dept('B'), collegeAdminRole],
      // 没有任何角色：权限码缺失 → 403 / 10003（权限守卫先挡）
      ['noPerm', dept('A'), null],
    ];
    for (const [username, deptId, role] of users) {
      const user = await seedUser(prisma, { username, deptId });
      if (role !== null) {
        await linkUserRole(user.userId, BigInt(role.id));
      }
    }

    for (const login of [
      'S_A',
      'S_B',
      'S_P',
      'S_F',
      'S_O',
      'T_X',
      'T_Y',
      'adminA',
      'adminB',
      'noPerm',
    ]) {
      const tokens = await loginAs(app, login, 'Passw0rd!');
      agents.set(login, authedAgent(app, tokens.accessToken));
    }

    for (const login of ['T_X', 'T_Y', 'T_Z']) {
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

    // 基础数据集：恰好 3 条（判据 1 的「恰好几条」建立在这三条之上）
    baseAppointments.set(
      'S_A_TO_T_X',
      await createAppointment({
        student: 'S_A',
        mentor: 'T_X',
        topic: '基础一：S_A 约 T_X',
        type: 1,
        status: 0,
      }),
    );
    baseAppointments.set(
      'S_B_TO_T_X',
      await createAppointment({
        student: 'S_B',
        mentor: 'T_X',
        topic: '基础二：S_B 约 T_X',
        type: 1,
        status: 0,
      }),
    );
    baseAppointments.set(
      'S_B_TO_T_Y',
      await createAppointment({
        student: 'S_B',
        mentor: 'T_Y',
        topic: '基础三：S_B 约 T_Y',
        type: 2,
        status: 0,
      }),
    );
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

  function base(key: string): Appointment {
    const row = baseAppointments.get(key);
    if (row === undefined) {
      throw new Error(`没有基础预约 ${key}`);
    }
    return row;
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

  async function createAppointment(input: {
    student: string;
    mentor: string;
    topic: string;
    type?: number;
    status?: number;
    requestedTime?: Date;
  }): Promise<Appointment> {
    return prisma.client.appointment.create({
      data: {
        studentPersonId: personId(input.student),
        mentorProfileId: profileOf(input.mentor).id,
        type: input.type ?? 1,
        status: input.status ?? 0,
        requestedTime:
          input.requestedTime ?? new Date(Date.now() + 24 * HOUR_MS),
        topic: input.topic,
        questions: '列表 / 详情用例的问题描述',
        mode: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
  }

  /**
   * 把两条预约的 `created_at` 钉成同一毫秒（判据 4 的排序稳定性）。
   *
   * 只能走裸 SQL：审计扩展在**每一次** create / update 上都会重写 `created_at`
   * （DB-06 的不可变列），Prisma 的任何写路径都设不进指定值。这是**测试造数**，
   * 不是业务写——业务代码里裸写仍然绝对禁止（LAYER-09）。
   */
  async function pinCreatedAt(ids: bigint[], at: Date): Promise<void> {
    const placeholders = ids.map(() => '?').join(', ');
    await prisma.client.$executeRawUnsafe(
      `UPDATE appointment SET created_at = ? WHERE id IN (${placeholders})`,
      at,
      ...ids,
    );
  }

  async function listAs(
    login: string,
    query = '',
  ): Promise<AppointmentListResponseDto> {
    const response = await api(login).get(`/appointments${query}`).expect(200);
    return (response.body as ResponseEnvelope<AppointmentListResponseDto>).data;
  }

  function expectFieldError(response: { body: unknown }, field: string): void {
    const data = response.body as ResponseEnvelope<{ fields: FieldErrorDto[] }>;
    expect(data.code).toBe(ErrorCode.PARAM_INVALID);
    expect(data.data.fields.some((f) => f.field === field)).toBe(true);
  }

  // ── 判据 1：三种角色各自只看到该看的 ──────────────────────────────

  it('判据 1：学生 / 导师 / 管理员 / 超管 各看到自己那份（3 条基础预约）', async () => {
    const sA = base('S_A_TO_T_X');
    const sBx = base('S_B_TO_T_X');
    const sBy = base('S_B_TO_T_Y');

    // 学生视角：S_A 只看自己发起的 1 条；S_B 看自己发起的 2 条
    const listA = await listAs('S_A');
    expect(listA.total).toBe(1);
    expect(listA.list.map((row) => row.id)).toEqual([sA.id.toString()]);

    const listB = await listAs('S_B');
    expect(listB.total).toBe(2);
    expect(new Set(listB.list.map((row) => row.id))).toEqual(
      new Set([sBx.id.toString(), sBy.id.toString()]),
    );

    // 导师视角：T_X 看约自己的 2 条（跨学生），T_Y 只看 1 条
    const listX = await listAs('T_X');
    expect(listX.total).toBe(2);
    expect(new Set(listX.list.map((row) => row.id))).toEqual(
      new Set([sA.id.toString(), sBx.id.toString()]),
    );

    const listY = await listAs('T_Y');
    expect(listY.total).toBe(1);
    expect(listY.list.map((row) => row.id)).toEqual([sBy.id.toString()]);

    // 管理员视角：按**申请人部门**收窄（R14）——adminA 只看学院 A 的申请人
    const listAdminA = await listAs('adminA');
    expect(listAdminA.total).toBe(1);
    expect(listAdminA.list.map((row) => row.id)).toEqual([sA.id.toString()]);

    const listAdminB = await listAs('adminB');
    expect(listAdminB.total).toBe(2);
    expect(new Set(listAdminB.list.map((row) => row.id))).toEqual(
      new Set([sBx.id.toString(), sBy.id.toString()]),
    );

    // 超管（有效范围 all）：不加约束，3 条全在
    const listAll = await listAs('admin');
    expect(listAll.total).toBe(3);
  });

  it('判据 1b：列表项带 student / mentor 联查值，BIGINT 一律字符串', async () => {
    const list = await listAs('S_A');
    const row = list.list[0];
    expect(row).toMatchObject({
      id: base('S_A_TO_T_X').id.toString(),
      studentPersonId: personId('S_A').toString(),
      mentorProfileId: profileOf('T_X').id.toString(),
      student: {
        personId: personId('S_A').toString(),
        login: 'S_A',
        realName: 'S_A-姓名',
        orgUnitName: '学院 A 组织',
      },
      mentor: {
        mentorProfileId: profileOf('T_X').id.toString(),
        realName: 'T_X-姓名',
        orgUnitName: '学院 A 组织',
      },
    });
    expect(typeof row.requestedTime).toBe('string');
    expect(typeof row.studentPersonId).toBe('string');
  });

  it('判据 1c：type 过滤只回该类型（超管视角，基础集 type=2 仅 1 条）', async () => {
    const list = await listAs('admin', '?type=2');
    expect(list.total).toBe(1);
    expect(list.list[0]?.id).toBe(base('S_B_TO_T_Y').id.toString());
  });

  it('判据 1d：缺 appointment:list → 403 / 10003', async () => {
    const response = await api('noPerm').get('/appointments').expect(403);
    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.FORBIDDEN);
    expect(data.message).toContain('appointment:list');
  });

  // ── 判据 5–7：详情可见性 ──────────────────────────────────────────

  it('判据 5 / 6 / 7：详情可见性——本人 / 导师 / 本院管理员 200，跨院与别人 403，不存在 404', async () => {
    const id = base('S_A_TO_T_X').id;

    // 可见三种：申请人本人 / 该预约的导师本人 / 覆盖申请人部门的管理员
    for (const login of ['S_A', 'T_X', 'adminA']) {
      const response = await api(login).get(`/appointments/${id}`).expect(200);
      const data = (response.body as ResponseEnvelope<AppointmentDetailDto>)
        .data;
      expect(data.id).toBe(id.toString());
      expect(data.student.login).toBe('S_A');
    }

    // 不可见三种：别的学生 / 别的导师 / 外院管理员 → 403 / 32002（不是 404）
    for (const login of ['S_B', 'T_Y', 'adminB']) {
      const response = await api(login).get(`/appointments/${id}`).expect(403);
      const data = response.body as ResponseEnvelope<null>;
      expect(data.code).toBe(ErrorCode.APPOINTMENT_FORBIDDEN);
      expect(data.message).toBe('无权访问该预约');
    }

    // 不存在 → 404 / 32001
    const missing = await api('S_A').get('/appointments/999999999').expect(404);
    const data = missing.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.APPOINTMENT_NOT_FOUND);
    expect(data.message).toBe('预约不存在');
  });

  it('判据 8：详情里的 student.login / orgUnitName / major / className / mobile 是真实联查值', async () => {
    const response = await api('S_A')
      .get(`/appointments/${base('S_A_TO_T_X').id}`)
      .expect(200);
    const data = (response.body as ResponseEnvelope<AppointmentDetailDto>).data;

    // 联的是 appointment.student_id → sync_person（不是导师、不是预约人 ID）
    expect(data.student).toEqual({
      personId: personId('S_A').toString(),
      login: 'S_A',
      realName: 'S_A-姓名',
      orgUnitName: '学院 A 组织',
      major: '软件工程',
      className: '软工 2023-1 班',
      mobile: '13800000000',
    });
    // 导师侧联的是 mentor_id → mentor_profile → sync_person
    expect(data.mentor).toEqual({
      mentorProfileId: profileOf('T_X').id.toString(),
      realName: 'T_X-姓名',
      orgUnitName: '学院 A 组织',
    });
  });

  // ── 判据 2 / 3：过滤与分页边界 ────────────────────────────────────

  it('判据 2：status=0 只回 0；status=99 → 400 / 10001 点名 status', async () => {
    const pending = await createAppointment({
      student: 'S_F',
      mentor: 'T_X',
      topic: 'S_F 的待处理预约',
      status: 0,
    });
    const completed = await createAppointment({
      student: 'S_F',
      mentor: 'T_X',
      topic: 'S_F 的已完成预约',
      status: 6,
    });

    const list = await listAs('S_F', '?status=0');
    expect(list.total).toBe(1);
    expect(list.list.map((row) => row.id)).toEqual([pending.id.toString()]);
    expect(list.list.every((row) => row.status === 0)).toBe(true);
    expect(list.list.some((row) => row.id === completed.id.toString())).toBe(
      false,
    );

    for (const status of [99, -1]) {
      const response = await api('S_F')
        .get(`/appointments?status=${status}`)
        .expect(400);
      expectFieldError(response, 'status');
    }
  });

  it('判据 2b：from/to 按 requestedTime 过滤；纯日期 to 含当天；非法或倒置 → 400', async () => {
    const jan = await createAppointment({
      student: 'S_F',
      mentor: 'T_X',
      topic: '时间过滤 2025-01',
      requestedTime: new Date('2025-01-15T02:00:00.000Z'),
    });
    const jun = await createAppointment({
      student: 'S_F',
      mentor: 'T_X',
      topic: '时间过滤 2025-06',
      requestedTime: new Date('2025-06-15T02:00:00.000Z'),
    });
    const dec = await createAppointment({
      student: 'S_F',
      mentor: 'T_X',
      topic: '时间过滤 2025-12',
      requestedTime: new Date('2025-12-15T02:00:00.000Z'),
    });

    const range = await listAs('S_F', '?from=2025-06-01&to=2025-06-30');
    expect(range.total).toBe(1);
    expect(range.list.map((row) => row.id)).toEqual([jun.id.toString()]);
    expect(range.list.some((row) => row.id === jan.id.toString())).toBe(false);
    expect(range.list.some((row) => row.id === dec.id.toString())).toBe(false);

    // 纯日期 to 表示当天结束：23:59:59 的预约仍命中
    const late = await createAppointment({
      student: 'S_F',
      mentor: 'T_X',
      topic: '时间过滤 2025-06-30 当天末尾',
      requestedTime: new Date('2025-06-30T23:59:59.000Z'),
    });
    const sameDay = await listAs('S_F', '?from=2025-06-30&to=2025-06-30');
    expect(sameDay.list.map((row) => row.id)).toEqual([late.id.toString()]);

    const bad = await api('S_F')
      .get('/appointments?from=not-a-date')
      .expect(400);
    expectFieldError(bad, 'from');

    const reversed = await api('S_F')
      .get('/appointments?from=2025-07-01&to=2025-06-01')
      .expect(400);
    const reversedBody = reversed.body as ResponseEnvelope<null>;
    expect(reversedBody.code).toBe(ErrorCode.PARAM_INVALID);
    expect(reversedBody.message).toBe('from 必须不晚于 to');
  });

  it('判据 3：pageSize=101 → 400 / 10001；pageSize=100 正常', async () => {
    const response = await api('S_P')
      .get('/appointments?pageSize=101')
      .expect(400);
    expectFieldError(response, 'pageSize');

    const ok = await listAs('S_P', '?pageSize=100');
    expect(ok.pageSize).toBe(100);
  });

  it('判据 9：total 是过滤后的总数，不是当前页条数（25 条 / pageSize=20）', async () => {
    for (let index = 0; index < 25; index += 1) {
      await createAppointment({
        student: 'S_P',
        mentor: 'T_Z',
        topic: `分页造数 ${index + 1}`,
      });
    }

    const page1 = await listAs('S_P', '?pageSize=20');
    expect(page1.total).toBe(25);
    expect(page1.list).toHaveLength(20);
    expect(page1.page).toBe(1);
    expect(page1.pageSize).toBe(20);

    const page2 = await listAs('S_P', '?page=2&pageSize=20');
    expect(page2.total).toBe(25);
    expect(page2.list).toHaveLength(5);

    const full = await listAs('S_P', '?pageSize=100');
    expect(full.total).toBe(25);
    expect(full.list).toHaveLength(25);
  });

  // ── 判据 4：排序稳定 ──────────────────────────────────────────────

  it('判据 4：createdAt 倒序；同一毫秒再按 id 倒序（稳定排序）', async () => {
    // 主序 createdAt 倒序：用判据 9 之后不再断言条数的 S_P，钉两个不同时刻
    const older = await createAppointment({
      student: 'S_P',
      mentor: 'T_Z',
      topic: '排序-旧',
    });
    const newer = await createAppointment({
      student: 'S_P',
      mentor: 'T_Z',
      topic: '排序-新',
    });
    await pinCreatedAt([older.id], new Date('2026-10-30T08:00:00.001Z'));
    await pinCreatedAt([newer.id], new Date('2026-10-30T08:00:00.002Z'));

    const ordered = await listAs('S_P', '?pageSize=100');
    const olderIndex = ordered.list.findIndex(
      (row) => row.id === older.id.toString(),
    );
    const newerIndex = ordered.list.findIndex(
      (row) => row.id === newer.id.toString(),
    );
    expect(newerIndex).toBeGreaterThanOrEqual(0);
    expect(olderIndex).toBeGreaterThanOrEqual(0);
    // createdAt 新的在前（改成 ASC 会翻过来）
    expect(newerIndex).toBeLessThan(olderIndex);

    // 同一毫秒只能靠 id 定序：S_O 专属两条
    const first = await createAppointment({
      student: 'S_O',
      mentor: 'T_Z',
      topic: '同毫秒 A',
    });
    const second = await createAppointment({
      student: 'S_O',
      mentor: 'T_Z',
      topic: '同毫秒 B',
    });
    const sameInstant = new Date('2026-10-30T08:00:00.000Z');
    await pinCreatedAt([first.id, second.id], sameInstant);

    const lowerId = first.id < second.id ? first.id : second.id;
    const higherId = first.id < second.id ? second.id : first.id;

    const list = await listAs('S_O');
    expect(list.total).toBe(2);
    // 同一毫秒 → 只能靠 id 定序；id 大的在前
    expect(list.list.map((row) => row.id)).toEqual([
      higherId.toString(),
      lowerId.toString(),
    ]);
  });

  // ── 判据 8b：学生 / 导师分属不同组织，orgUnitName 不串台 ──────────

  it('判据 8b：学生与导师分属不同组织时，列表项各自的 orgUnitName 取自本人组织', async () => {
    // S_A 在「学院 A 组织」（部门 A），T_Y 在「学院 B 组织」（部门 B）——两个
    // SyncOrgUnit、名字不同。若实现把 student.orgUnitName 错接到导师的组织
    // （或写成常量），本用例必须转红。两条断言都要有：只钉 `===` 时，两边
    // 同名仍不转红。这里新造一条跨组织预约，不依赖既有同名的 S_A→T_X 夹具。
    const appointment = await createAppointment({
      student: 'S_A',
      mentor: 'T_Y',
      topic: '跨组织：S_A 约 T_Y',
    });

    const list = await listAs('admin', '?pageSize=100');
    const row = list.list.find((item) => item.id === appointment.id.toString());
    if (row === undefined) {
      throw new Error('列表里没有跨组织预约');
    }

    // 学生侧取自学生自己的组织，而不是导师的
    expect(row.student.orgUnitName).toBe('学院 A 组织');
    expect(row.student.orgUnitName).not.toBe('学院 B 组织');
    // 导师侧钉住另一半，防止两侧一起接错还「自洽」
    expect(row.mentor.orgUnitName).toBe('学院 B 组织');
    expect(row.mentor.orgUnitName).not.toBe('学院 A 组织');
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
