import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { runWithSyncWrite } from '../src/infra/prisma/sync-write-scope';
import { ErrorCode } from '../src/common/constants/error-code';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import type { AppointmentStatsResponseDto } from '../src/modules/stats/dto/appointment-stats.dto';
import type { AssessmentStatsResponseDto } from '../src/modules/stats/dto/assessment-stats.dto';
import type { WorkbenchResponseDto } from '../src/modules/stats/dto/workbench.dto';
import type { GuidanceStatsResponseDto } from '../src/modules/stats/dto/guidance-stats.dto';
import type { MentorStatsResponseDto } from '../src/modules/stats/dto/mentor-stats.dto';
import { currentPeriod } from '../src/modules/assessment/assessment.constants';
import {
  authedAgent,
  clearBusinessTables,
  clearModuleTables,
  loginAs,
  seedSuperAdmin,
  seedUser,
  type E2eApi,
} from './e2e-helpers';

const SYNCED_AT = new Date('2026-10-27T00:00:00.000Z');
const CURRENT_YEAR = String(new Date().getUTCFullYear());
const CURRENT_PERIOD = currentPeriod();

/**
 * 导师资源库统计（P4 Task 45 / §4.1）。
 *
 * 夹具刻意做成「校内 / 校外、生效 / 待审核、活跃 / 非活跃、多方向重复」四种组合，
 * 一条用例就能把六个统计口径同时钉住。
 */
describe('导师资源库统计（P4 Task 45）(e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const agents = new Map<string, E2eApi>();
  const permissionIds = new Map<string, bigint>();
  const deptIds = new Map<string, bigint>();
  const people = new Map<string, bigint>();
  let studentId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);

    await clearStatsTables(prisma);
    await clearBusinessTables(prisma);
    await clearModuleTables(prisma);

    await seedSuperAdmin(prisma);
    const rootDept = await prisma.client.sysDept.findFirst({
      where: { name: '总公司' },
    });
    if (rootDept === null) {
      throw new Error('seedSuperAdmin 未种出「总公司」部门');
    }
    deptIds.set('root', rootDept.id);
    deptIds.set('A', await createDept('统计 A 组织', rootDept.id));
    deptIds.set('B', await createDept('统计 B 组织', rootDept.id));

    const orgA = await createOrg('ORG-STAT-A', '统计 A 组织', dept('A'));
    const orgB = await createOrg('ORG-STAT-B', '统计 B 组织', dept('B'));

    // A1 活跃校内；A2 非活跃校内；A3 待审核校内；B1 活跃校外；S 学生
    for (const [login, personType, orgUnitId] of [
      ['stat-a1', 'internalMentor', orgA],
      ['stat-a2', 'internalMentor', orgA],
      ['stat-a3', 'internalMentor', orgA],
      ['stat-b1', 'externalMentor', orgB],
      ['stat-student', 'student', orgA],
    ] as const) {
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
      people.set(login, person.id);
    }
    studentId = personOf('stat-student');

    const a1 = await createProfile('stat-a1', 2, ['创新创业', '人工智能']);
    await createProfile('stat-a2', 2, ['创新创业']);
    await createProfile('stat-a3', 1, ['其他方向']);
    const b1 = await createProfile('stat-b1', 2, ['人工智能']);

    // 活跃判定：周期内有 status = 6 的预约
    await createCompletedAppointment(a1);
    await createCompletedAppointment(b1);

    const collegeRole = await createRole(
      '统计学院管理员',
      'stat_college',
      'dept',
      [
        'stats:mentor',
        'stats:appointment',
        'stats:guidance',
        'stats:assessment',
      ],
    );
    const scRole = await createRole('统计双创学院', 'stat_sc', 'all', [
      'stats:mentor',
      'stats:appointment',
      'stats:guidance',
      'stats:assessment',
    ]);
    const mentorRole = await createRole('统计导师', 'stat_mentor', 'self', [
      'stats:guidance',
    ]);
    const studentRole = await createRole('统计学生', 'stat_student', 'self', [
      'stats:guidance',
    ]);
    const users: Array<[string, bigint, bigint]> = [
      ['stat-college-a', collegeRole, dept('A')],
      ['stat-sc', scRole, dept('root')],
      ['stat-a1', mentorRole, dept('A')],
      ['stat-student', studentRole, dept('A')],
    ];
    for (const [username, roleId, deptId] of users) {
      const user = await seedUser(prisma, { username, deptId });
      await prisma.client.sysUserRole.create({
        data: { userId: user.userId, roleId, createdBy: 0n, updatedBy: 0n },
      });
    }
    for (const [username] of users) {
      const tokens = await loginAs(app, username, 'Passw0rd!');
      agents.set(username, authedAgent(app, tokens.accessToken));
    }
  });

  afterAll(async () => {
    try {
      if (prisma !== undefined) {
        await clearStatsTables(prisma);
        await clearBusinessTables(prisma);
        await clearModuleTables(prisma);
      }
    } finally {
      if (app !== undefined) {
        await app.close();
      }
    }
  });

  function dept(key: string): bigint {
    const id = deptIds.get(key);
    if (id === undefined) {
      throw new Error(`没有 ${key} 部门`);
    }
    return id;
  }

  function personOf(login: string): bigint {
    const id = people.get(login);
    if (id === undefined) {
      throw new Error(`没有 ${login} 的 SyncPerson`);
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

  async function createProfile(
    login: string,
    status: number,
    researchFields: string[],
  ): Promise<bigint> {
    const row = await prisma.client.mentorProfile.create({
      data: {
        personId: personOf(login),
        researchFields,
        status,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    return row.id;
  }

  async function createCompletedAppointment(mentorId: bigint): Promise<void> {
    await prisma.client.appointment.create({
      data: {
        studentPersonId: studentId,
        mentorProfileId: mentorId,
        type: 1,
        status: 6,
        requestedTime: new Date(`${CURRENT_YEAR}-06-01T02:00:00.000Z`),
        topic: '统计夹具：已完成的预约',
        questions: '这条预约只用于让该导师在统计周期内算作「活跃」',
        mode: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
  }

  async function ensurePermissionId(code: string): Promise<bigint> {
    const cached = permissionIds.get(code);
    if (cached !== undefined) {
      return cached;
    }
    const row = await prisma.client.sysPermission.create({
      data: {
        type: 'BUTTON',
        code,
        name: `P4 ${code}`,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    permissionIds.set(code, row.id);
    return row.id;
  }

  async function createRole(
    name: string,
    code: string,
    dataScope: string,
    permCodes: readonly string[],
  ): Promise<bigint> {
    const role = await prisma.client.sysRole.create({
      data: { name, code, dataScope, createdBy: 0n, updatedBy: 0n },
    });
    for (const permCode of permCodes) {
      await prisma.client.sysRolePermission.create({
        data: {
          roleId: role.id,
          permissionId: await ensurePermissionId(permCode),
          createdBy: 0n,
          updatedBy: 0n,
        },
      });
    }
    return role.id;
  }

  it('判据 1：双创学院看全校——六个口径都对得上', async () => {
    const response = await api('stat-sc').get('/stats/mentors').expect(200);
    const data = (response.body as ResponseEnvelope<MentorStatsResponseDto>)
      .data;

    expect(data).toMatchObject({
      // 生效 3 份：A1 / A2 / B1；A3 待审核不计
      total: 3,
      internal: 2,
      external: 1,
      // 周期内有 status = 6 预约的：A1 / B1
      active: 2,
      inactive: 1,
    });
    // 六个键必须齐全（缺项补 0），A3 计入 pending
    expect(data.byStatus).toEqual({
      draft: 0,
      pending: 1,
      approved: 3,
      rejected: 0,
      frozen: 0,
      removed: 0,
    });
    // 同一导师的重复方向只计一次；待审核的不进方向分布
    expect(data.byResearchField).toEqual([
      { field: '人工智能', count: 2 },
      { field: '创新创业', count: 2 },
    ]);
  });

  it('判据 2：学院管理员只统计本院', async () => {
    const response = await api('stat-college-a')
      .get('/stats/mentors')
      .expect(200);
    const data = (response.body as ResponseEnvelope<MentorStatsResponseDto>)
      .data;

    expect(data).toMatchObject({
      total: 2,
      internal: 2,
      external: 0,
      active: 1,
      inactive: 1,
    });
    expect(data.byStatus.approved).toBe(2);
    expect(data.byStatus.pending).toBe(1);
    // 校外那个在 B 院，方向分布里不该有它带来的第二个人工智能
    expect(data.byResearchField).toEqual([
      { field: '创新创业', count: 2 },
      { field: '人工智能', count: 1 },
    ]);
  });

  it('判据 3：学院管理员传 deptId → 403 / 10003（越权指定范围）', async () => {
    const response = await api('stat-college-a')
      .get('/stats/mentors')
      .query({ deptId: dept('B').toString() })
      .expect(403);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  it('判据 4：双创学院传 deptId 下钻 → 只统计该院', async () => {
    const response = await api('stat-sc')
      .get('/stats/mentors')
      .query({ deptId: dept('B').toString() })
      .expect(200);
    const data = (response.body as ResponseEnvelope<MentorStatsResponseDto>)
      .data;

    expect(data).toMatchObject({
      total: 1,
      internal: 0,
      external: 1,
      active: 1,
      inactive: 0,
    });
  });

  it('判据 5：period 与 from 同传 → 400 / 10001', async () => {
    const response = await api('stat-sc')
      .get('/stats/mentors')
      .query({ period: CURRENT_YEAR, from: `${CURRENT_YEAR}-01-01` })
      .expect(400);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PARAM_INVALID,
    );
  });

  it('判据 6：from / to 只给一个 → 400 / 10001', async () => {
    const response = await api('stat-sc')
      .get('/stats/mentors')
      .query({ from: `${CURRENT_YEAR}-01-01` })
      .expect(400);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PARAM_INVALID,
    );
  });

  it('判据 7：from 晚于 to → 400 / 10001', async () => {
    const response = await api('stat-sc')
      .get('/stats/mentors')
      .query({ from: `${CURRENT_YEAR}-12-31`, to: `${CURRENT_YEAR}-01-01` })
      .expect(400);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PARAM_INVALID,
    );
  });

  it('判据 8：mentorType=external → 只剩校外导师', async () => {
    const response = await api('stat-sc')
      .get('/stats/mentors')
      .query({ mentorType: 'external' })
      .expect(200);
    const data = (response.body as ResponseEnvelope<MentorStatsResponseDto>)
      .data;

    expect(data).toMatchObject({
      total: 1,
      internal: 0,
      external: 1,
      active: 1,
    });
  });

  // ── 预约统计（Task 46）──────────────────────────────────────────

  it('判据 9：预约统计——10 个状态齐全、两个比率、失败名单', async () => {
    // 现状：A1 与 B1 各 1 条 `6`。给 A1 再补 3 条 `7`，让失败对数达到阈值 3。
    const a1 = await prisma.client.mentorProfile.findFirst({
      where: { personId: personOf('stat-a1') },
    });
    if (a1 === null) {
      throw new Error('A1 档案不见了');
    }
    for (let i = 0; i < 3; i += 1) {
      await prisma.client.appointment.create({
        data: {
          studentPersonId: studentId,
          mentorProfileId: a1.id,
          type: 1,
          status: 7,
          requestedTime: new Date(`${CURRENT_YEAR}-07-0${i + 1}T02:00:00.000Z`),
          topic: `失败预约 ${i + 1}`,
          questions: '这条预约只用于让该师生对进入失败名单',
          mode: 1,
          createdBy: 0n,
          updatedBy: 0n,
        },
      });
    }

    const response = await api('stat-sc')
      .get('/stats/appointments')
      .expect(200);
    const data = (
      response.body as ResponseEnvelope<AppointmentStatsResponseDto>
    ).data;

    expect(data.total).toBe(5);
    // 10 个状态全列，且按 0→9 升序
    expect(data.byStatus.map((item) => item.status)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    const countOf = (status: number): number =>
      data.byStatus.find((item) => item.status === status)?.count ?? -1;
    expect(countOf(6)).toBe(2);
    expect(countOf(7)).toBe(3);

    // acceptanceRate = 2/5（1..6 共 2 条）；completionRate = 2/(6,7,8,9 共 5 条)
    expect(data.acceptanceRate).toBe(0.4);
    expect(data.completionRate).toBe(0.4);

    expect(data.failedPairs).toHaveLength(1);
    expect(data.failedPairs[0]).toMatchObject({
      studentPersonId: studentId.toString(),
      studentName: 'stat-student',
      mentorProfileId: a1.id.toString(),
      mentorName: 'stat-a1',
      failedCount: 3,
    });
  });

  it('判据 10：学院只看本院导师收到的预约', async () => {
    const response = await api('stat-college-a')
      .get('/stats/appointments')
      .expect(200);
    const data = (
      response.body as ResponseEnvelope<AppointmentStatsResponseDto>
    ).data;

    // A 院：A1 的 1 条 `6` + 3 条 `7` = 4（B1 那条不算）
    expect(data.total).toBe(4);
    expect(data.acceptanceRate).toBe(0.25);
    expect(data.completionRate).toBe(0.25);
    expect(data.failedPairs).toHaveLength(1);
  });

  it('判据 11：没有预约的时间段 → 两个比率都是 null（不是 0）', async () => {
    const response = await api('stat-sc')
      .get('/stats/appointments')
      .query({ period: '2030' })
      .expect(200);
    const data = (
      response.body as ResponseEnvelope<AppointmentStatsResponseDto>
    ).data;

    expect(data.total).toBe(0);
    expect(data.acceptanceRate).toBeNull();
    expect(data.completionRate).toBeNull();
    expect(data.failedPairs).toEqual([]);
    // 状态分布仍然 10 条全在，只是全为 0
    expect(data.byStatus).toHaveLength(10);
    expect(data.byStatus.every((item) => item.count === 0)).toBe(true);
  });

  // ── 指导工作统计（Task 47）──────────────────────────────────────

  it('判据 12：指导统计——次数 / 时长 / 学生数 / 类型拆分 / 按导师下钻', async () => {
    const a1 = await prisma.client.mentorProfile.findFirst({
      where: { personId: personOf('stat-a1') },
    });
    const b1 = await prisma.client.mentorProfile.findFirst({
      where: { personId: personOf('stat-b1') },
    });
    if (a1 === null || b1 === null) {
      throw new Error('档案不见了');
    }
    const apptA1 = await prisma.client.appointment.findFirst({
      where: { mentorProfileId: a1.id, status: 6 },
    });
    const apptB1 = await prisma.client.appointment.findFirst({
      where: { mentorProfileId: b1.id, status: 6 },
    });
    if (apptA1 === null || apptB1 === null) {
      throw new Error('已完成的预约不见了');
    }

    // 一条预约只能有一条指导记录（DB 唯一键），所以多出来的量要靠**多条预约**
    const apptA1b = await prisma.client.appointment.create({
      data: {
        studentPersonId: studentId,
        mentorProfileId: a1.id,
        type: 2,
        status: 6,
        requestedTime: new Date(`${CURRENT_YEAR}-06-03T02:00:00.000Z`),
        topic: '指导统计夹具 2',
        questions: '这条预约只用于造第二条指导记录',
        mode: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });

    const record = (appointmentId: bigint, minutes: number) => ({
      appointmentId,
      actualTime: new Date(`${CURRENT_YEAR}-06-02T02:00:00.000Z`),
      mode: 1,
      coreContent: '指导记录',
      followUp: '下次继续',
      durationMinutes: minutes,
      submittedBy: personOf('stat-a1'),
      submittedAt: new Date(`${CURRENT_YEAR}-06-02T03:00:00.000Z`),
      createdBy: 0n,
      updatedBy: 0n,
    });
    // A1 两条（type 1 / type 2），B1 一条（type 1）
    await prisma.client.guidanceRecord.create({
      data: record(apptA1.id, 60),
    });
    await prisma.client.guidanceRecord.create({
      data: record(apptA1b.id, 90),
    });
    await prisma.client.guidanceRecord.create({
      data: record(apptB1.id, 60),
    });

    const response = await api('stat-sc')
      .get('/stats/guidance')
      .query({ period: CURRENT_YEAR })
      .expect(200);
    const data = (response.body as ResponseEnvelope<GuidanceStatsResponseDto>)
      .data;

    expect(data).toMatchObject({
      guidanceCount: 3,
      guidanceMinutes: 210,
      // 去重：同一个学生 3 次只算 1 人
      studentCount: 1,
      byMentorTotal: 2,
    });
    // 1-5 五条齐全
    expect(data.byType.map((item) => item.type)).toEqual([1, 2, 3, 4, 5]);
    const typeOf = (type: number) =>
      data.byType.find((item) => item.type === type);
    expect(typeOf(1)).toEqual({ type: 1, count: 2, minutes: 120 });
    expect(typeOf(2)).toEqual({ type: 2, count: 1, minutes: 90 });
    expect(typeOf(3)).toEqual({ type: 3, count: 0, minutes: 0 });

    expect(data.byMentor).toHaveLength(2);
    const a1Row = data.byMentor.find(
      (item) => item.mentorProfileId === a1.id.toString(),
    );
    expect(a1Row).toMatchObject({
      mentorName: 'stat-a1',
      guidanceCount: 2,
      guidanceMinutes: 150,
      studentCount: 1,
    });
  });

  it('判据 13：学院只看本院导师的指导量', async () => {
    const response = await api('stat-college-a')
      .get('/stats/guidance')
      .query({ period: CURRENT_YEAR })
      .expect(200);
    const data = (response.body as ResponseEnvelope<GuidanceStatsResponseDto>)
      .data;

    // A 院只有 A1 的两条（60 + 90）
    expect(data.guidanceCount).toBe(2);
    expect(data.guidanceMinutes).toBe(150);
    expect(data.byMentorTotal).toBe(1);
  });

  it('判据 14：导师传别人的 mentorId → 403 / 10003（不静默改成自己）', async () => {
    const b1 = await prisma.client.mentorProfile.findFirst({
      where: { personId: personOf('stat-b1') },
    });
    if (b1 === null) {
      throw new Error('B1 档案不见了');
    }

    const response = await api('stat-a1')
      .get('/stats/guidance')
      .query({ mentorId: b1.id.toString() })
      .expect(403);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  it('判据 15：导师看自己的台账 → 只有本人的数据', async () => {
    const response = await api('stat-a1')
      .get('/stats/guidance')
      .query({ period: CURRENT_YEAR })
      .expect(200);
    const data = (response.body as ResponseEnvelope<GuidanceStatsResponseDto>)
      .data;

    expect(data.guidanceCount).toBe(2);
    expect(data.guidanceMinutes).toBe(150);
    expect(data.byMentorTotal).toBe(1);
  });

  // ── 考核等级分布（Task 48）──────────────────────────────────────

  it('判据 16：只统计已生效的考核，三个维度分布之和自洽', async () => {
    const a1 = await prisma.client.mentorProfile.findFirst({
      where: { personId: personOf('stat-a1') },
    });
    const a2 = await prisma.client.mentorProfile.findFirst({
      where: { personId: personOf('stat-a2') },
    });
    const b1 = await prisma.client.mentorProfile.findFirst({
      where: { personId: personOf('stat-b1') },
    });
    const a3 = await prisma.client.mentorProfile.findFirst({
      where: { personId: personOf('stat-a3') },
    });
    if (a1 === null || a2 === null || b1 === null || a3 === null) {
      throw new Error('档案不见了');
    }

    const assessment = (
      mentorId: bigint,
      status: number,
      finalGrade: number | null,
    ) => ({
      mentorId,
      period: CURRENT_PERIOD,
      status,
      finalGrade,
      collegeGrade: 2,
      collegeComment: '初评',
      createdBy: 0n,
      updatedBy: 0n,
    });
    await prisma.client.assessment.create({
      data: assessment(a1.id, 2, 1),
    });
    await prisma.client.assessment.create({
      data: assessment(a2.id, 2, 2),
    });
    await prisma.client.assessment.create({
      data: assessment(b1.id, 2, 3),
    });
    // 未终评的那条不该进任何分布
    await prisma.client.assessment.create({
      data: assessment(a3.id, 1, null),
    });

    const response = await api('stat-sc')
      .get('/stats/assessments')
      .query({ period: CURRENT_PERIOD })
      .expect(200);
    const data = (response.body as ResponseEnvelope<AssessmentStatsResponseDto>)
      .data;

    expect(data.total).toBe(3);
    expect(data.byGrade).toEqual({
      excellent: 1,
      qualified: 1,
      unqualified: 1,
    });
    // 按学院：A 院 2 条、B 院 1 条
    expect(data.byDept.reduce((sum, row) => sum + row.total, 0)).toBe(3);
    expect(
      data.byDept.find((row) => row.deptName === '统计 A 组织'),
    ).toMatchObject({ excellent: 1, qualified: 1, unqualified: 0, total: 2 });
    expect(
      data.byDept.find((row) => row.deptName === '统计 B 组织'),
    ).toMatchObject({ excellent: 0, qualified: 0, unqualified: 1, total: 1 });
    // 按类型
    expect(data.byMentorType.reduce((sum, row) => sum + row.total, 0)).toBe(3);
    expect(
      data.byMentorType.find((row) => row.mentorType === 'internal'),
    ).toMatchObject({ excellent: 1, qualified: 1, unqualified: 0, total: 2 });
    expect(
      data.byMentorType.find((row) => row.mentorType === 'external'),
    ).toMatchObject({ excellent: 0, qualified: 0, unqualified: 1, total: 1 });
    // 按方向：A1 有两个方向，所以两个方向各计一次，总和大于 total
    const fieldTotal = data.byResearchField.reduce(
      (sum, row) => sum + row.total,
      0,
    );
    expect(fieldTotal).toBe(4);
    expect(
      data.byResearchField.find((row) => row.field === '创新创业'),
    ).toMatchObject({ excellent: 1, qualified: 1, total: 2 });
    expect(
      data.byResearchField.find((row) => row.field === '人工智能'),
    ).toMatchObject({ excellent: 1, unqualified: 1, total: 2 });
  });

  it('判据 17：学院只看本院导师的考核分布', async () => {
    const response = await api('stat-college-a')
      .get('/stats/assessments')
      .query({ period: CURRENT_PERIOD })
      .expect(200);
    const data = (response.body as ResponseEnvelope<AssessmentStatsResponseDto>)
      .data;

    expect(data.total).toBe(2);
    expect(data.byGrade).toEqual({
      excellent: 1,
      qualified: 1,
      unqualified: 0,
    });
  });

  it('判据 18：缺 period → 400 / 10001（考核分布脱离周期没有意义）', async () => {
    const response = await api('stat-sc').get('/stats/assessments').expect(400);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PARAM_INVALID,
    );
  });

  // ── 导师工作台（Task 49）────────────────────────────────────────

  it('判据 19：导师本人看工作台——三个计数、评价汇总、当年考核、归档数', async () => {
    const a1 = await prisma.client.mentorProfile.findFirst({
      where: { personId: personOf('stat-a1') },
    });
    if (a1 === null) {
      throw new Error('A1 档案不见了');
    }
    const makeAppt = (status: number) =>
      prisma.client.appointment.create({
        data: {
          studentPersonId: studentId,
          mentorProfileId: a1.id,
          type: 1,
          status,
          requestedTime: new Date(`${CURRENT_YEAR}-08-01T02:00:00.000Z`),
          topic: `工作台夹具 status=${status}`,
          questions: '这条预约只用于工作台的计数判据',
          mode: 1,
          createdBy: 0n,
          updatedBy: 0n,
        },
      });
    await makeAppt(0);
    await makeAppt(0);
    await makeAppt(1);
    await makeAppt(3);

    // 一条评价（挂在 A1 的已完成预约上）
    const completed = await prisma.client.appointment.findFirst({
      where: { mentorProfileId: a1.id, status: 6 },
    });
    if (completed === null) {
      throw new Error('已完成的预约不见了');
    }
    await prisma.client.studentReview.create({
      data: {
        appointmentId: completed.id,
        attitude: 5,
        expertise: 4,
        effect: 4,
        overallScore: '4.33',
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    // 一条归档
    await prisma.client.archiveItem.create({
      data: {
        targetType: 'Assessment',
        targetId: '999',
        title: '工作台夹具：归档条目',
        mentorId: a1.id,
        category: 'assessment',
        core: 1,
        archivedAt: new Date(`${CURRENT_YEAR}-09-01T00:00:00.000Z`),
        createdBy: 0n,
        updatedBy: 0n,
      },
    });

    const response = await api('stat-a1')
      .get(`/stats/workbench/${a1.id.toString()}`)
      .expect(200);
    const data = (response.body as ResponseEnvelope<WorkbenchResponseDto>).data;

    expect(data.pendingAppointments).toBe(2);
    expect(data.confirmedAppointments).toBe(1);
    expect(data.awaitingStudentConfirm).toBe(1);
    expect(data.reviewSummary).toEqual({
      count: 1,
      avg: 4.33,
      attitudeAvg: 5,
      expertiseAvg: 4,
      effectAvg: 4,
    });
    expect(data.currentAssessment).toMatchObject({
      period: CURRENT_PERIOD,
      status: 2,
      collegeGrade: 2,
      finalGrade: 1,
    });
    expect(data.archivedCount).toBe(1);
  });

  it('判据 20：别的导师看我的工作台 → 403 / 10003', async () => {
    const a2 = await prisma.client.mentorProfile.findFirst({
      where: { personId: personOf('stat-a2') },
    });
    if (a2 === null) {
      throw new Error('A2 档案不见了');
    }

    // stat-a1 的角色是 `self`，看 A2 的工作台越权
    const response = await api('stat-a1')
      .get(`/stats/workbench/${a2.id.toString()}`)
      .expect(403);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  it('判据 21：档案不存在 → 404 / 31102', async () => {
    const response = await api('stat-sc')
      .get('/stats/workbench/999999')
      .expect(404);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.MENTOR_PROFILE_NOT_FOUND,
    );
  });
  // ── 导出（Task 50）──────────────────────────────────────────────
  //
  // 分隔符用 `String.fromCharCode(13, 10)` 而不是字面量：CSV 行尾是 CRLF，
  // 而写进测试源码的转义字面量在编辑链路上极易被折叠成真实换行，
  // 把字符串写断。函数调用没有这个问题。

  const CSV_EOL = String.fromCharCode(13, 10);

  it('判据 22：导师名单导出——BOM + 表头 + ASCII 文件名', async () => {
    const response = await api('stat-sc')
      .get('/stats/mentors/export')
      .expect(200);

    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toMatch(
      /^attachment; filename="[A-Za-z0-9._-]+[.]csv"$/,
    );
    // UTF-8 BOM
    expect(response.text.charCodeAt(0)).toBe(0xfeff);
    const lines = response.text.slice(1).split(CSV_EOL);
    expect(lines[0]).toBe(
      '工号,姓名,导师类型,所属学院,职称,指导方向,档案状态,入驻时间',
    );
    // 4 份档案（含待审核那份），表头之后 4 行
    expect(lines.filter((line) => line.length > 0)).toHaveLength(5);
  });

  it('判据 23：超过 export.max_rows → 409 / 37004，且不返回半份 CSV', async () => {
    await prisma.client.sysConfig.create({
      data: {
        code: 'export.max_rows',
        name: '导出上限（测试用）',
        value: '2',
        valueType: 'number',
        status: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    try {
      const response = await api('stat-sc')
        .get('/stats/mentors/export')
        .expect(409);

      // 关键：**不是 200 + 被截断的 CSV**。判定发生在写 BOM 之前
      expect(response.headers['content-type']).toContain('application/json');
      expect((response.body as ResponseEnvelope<null>).code).toBe(
        ErrorCode.EXPORT_TOO_LARGE,
      );
    } finally {
      await prisma.includingDeleted.sysConfig.deleteMany({
        where: { code: 'export.max_rows' },
      });
    }
  });

  it('判据 24：学生导出个人档案——只含自己的已完成预约', async () => {
    const response = await api('stat-student')
      .get('/me/records/export')
      .expect(200);

    expect(response.text.charCodeAt(0)).toBe(0xfeff);
    const lines = response.text
      .slice(1)
      .split(CSV_EOL)
      .filter((line) => line.length > 0);
    expect(lines[0]).toBe(
      '预约ID,导师姓名,预约类型,指导主题,实际指导时间,指导时长(分钟),我的评分,我的评价',
    );
    // 该学生名下 status = 6 的预约：beforeAll 的 1 条 + 判据 12 造的 1 条 = 2
    expect(lines).toHaveLength(4);
  });

  it('判据 25：学生调导师名单导出 → 403 / 10003（名单类导出不给 self 范围）', async () => {
    const response = await api('stat-student')
      .get('/stats/mentors/export')
      .expect(403);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });
});

/** 清统计涉及的实体表（实体表走 includingDeleted，同步层走 syncWrite） */
async function clearStatsTables(prisma: PrismaService): Promise<void> {
  await prisma.includingDeleted.archiveItem.deleteMany({});
  await prisma.includingDeleted.assessmentAppeal.deleteMany({});
  await prisma.includingDeleted.assessment.deleteMany({});
  await prisma.includingDeleted.achievement.deleteMany({});
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
