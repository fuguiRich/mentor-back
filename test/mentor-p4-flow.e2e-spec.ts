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
import type { GuidanceStatsResponseDto } from '../src/modules/stats/dto/guidance-stats.dto';
import type { MentorStatsResponseDto } from '../src/modules/stats/dto/mentor-stats.dto';
import type {
  ArchiveListResponseDto,
  ArchiveResponseDto,
} from '../src/modules/archive/dto/archive-response.dto';
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
const YEAR = String(new Date().getUTCFullYear());
const TIME_ZONE = process.env.APP_TIMEZONE || 'Asia/Shanghai';
const CSV_EOL = String.fromCharCode(13, 10);

/**
 * P4 端到端验收（Task 55）：统计 → 导出 → 归档 → 清理一条链走到底。
 *
 * 夹具刻意做成「三个导师、八条预约覆盖 0/1/6/7/8/9、两条指导记录、一条
 * 已生效考核」——每一步都断言**具体数值**，不是「有数据」。
 */
describe('P4 端到端验收（统计 + 导出 + 归档）(e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const agents = new Map<string, E2eApi>();
  const permissionIds = new Map<string, bigint>();
  const deptIds = new Map<string, bigint>();
  const people = new Map<string, bigint>();
  const profiles = new Map<string, bigint>();

  let applicationId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);

    await clearFlowTables(prisma);
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
    deptIds.set('A', await createDept('P4 验收 A 学院', rootDept.id));
    deptIds.set('B', await createDept('P4 验收 B 学院', rootDept.id));

    const orgA = await createOrg('ORG-P4-A', 'P4 验收 A 组织', dept('A'));
    const orgB = await createOrg('ORG-P4-B', 'P4 验收 B 组织', dept('B'));

    for (const [login, personType, orgUnitId] of [
      ['m-a1', 'internalMentor', orgA],
      ['m-a2', 'internalMentor', orgA],
      ['m-b1', 'externalMentor', orgB],
      ['stu-a', 'student', orgA],
      ['stu-b', 'student', orgB],
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

    profiles.set('a1', await createProfile('m-a1', ['人工智能'], '教授'));
    profiles.set('a2', await createProfile('m-a2', ['创新创业'], '副教授'));
    profiles.set('b1', await createProfile('m-b1', ['人工智能'], '高工'));

    // 八条预约：0 / 1 / 6×2 / 7×2 / 8 / 9
    await createAppointment('stu-a', 'a1', 0, 1);
    await createAppointment('stu-a', 'a1', 1, 2);
    const completed1 = await createAppointment('stu-a', 'a1', 6, 3);
    const completed2 = await createAppointment('stu-a', 'a1', 6, 4);
    await createAppointment('stu-a', 'a2', 7, 5);
    await createAppointment('stu-a', 'a2', 7, 6);
    await createAppointment('stu-a', 'a2', 8, 7);
    await createAppointment('stu-b', 'b1', 9, 8);

    await createGuidanceRecord(completed1, 'm-a1', 120);
    await createGuidanceRecord(completed2, 'm-a1', 90);
    await createAchievement(profiles.get('a1') as bigint);
    await createAssessment(profiles.get('a1') as bigint);

    applicationId = await createApplication();

    const scRole = await createRole('P4 验收双创学院', 'p4_sc', 'all', [
      'stats:mentor',
      'stats:appointment',
      'stats:guidance',
      'stats:assessment',
      'archive:list',
      'archive:manage',
      'mentor-application:review-sc',
    ]);
    const collegeRole = await createRole(
      'P4 验收学院管理员',
      'p4_college',
      'deptAndChildren',
      [
        'stats:mentor',
        'stats:appointment',
        'stats:guidance',
        'stats:assessment',
        'archive:list',
      ],
    );
    const mentorRole = await createRole('P4 验收导师', 'p4_mentor', 'self', [
      'stats:guidance',
      'archive:list',
    ]);
    const studentRole = await createRole('P4 验收学生', 'p4_student', 'self', [
      'stats:guidance',
    ]);

    for (const [username, roleId, deptKey] of [
      ['p4-sc', scRole, 'root'],
      ['p4-college-a', collegeRole, 'A'],
      ['m-a1', mentorRole, 'A'],
      ['stu-a', studentRole, 'A'],
    ] as const) {
      const user = await seedUser(prisma, { username, deptId: dept(deptKey) });
      await prisma.client.sysUserRole.create({
        data: { userId: user.userId, roleId, createdBy: 0n, updatedBy: 0n },
      });
      const tokens = await loginAs(app, username, 'Passw0rd!');
      agents.set(username, authedAgent(app, tokens.accessToken));
    }
  });

  afterAll(async () => {
    try {
      if (prisma !== undefined) {
        await clearFlowTables(prisma);
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
    researchFields: string[],
    professionalTitle: string,
  ): Promise<bigint> {
    const row = await prisma.client.mentorProfile.create({
      data: {
        personId: personOf(login),
        researchFields,
        status: 2,
        professionalTitle,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    return row.id;
  }

  async function createAppointment(
    studentLogin: string,
    mentorKey: string,
    status: number,
    day: number,
  ): Promise<bigint> {
    const row = await prisma.client.appointment.create({
      data: {
        studentPersonId: personOf(studentLogin),
        mentorProfileId: profiles.get(mentorKey) as bigint,
        type: 1,
        status,
        requestedTime: new Date(
          `${YEAR}-06-${`${day}`.padStart(2, '0')}T02:00:00.000Z`,
        ),
        topic: `P4 验收预约 ${day}`,
        questions: 'P4 验收夹具',
        mode: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    return row.id;
  }

  async function createGuidanceRecord(
    appointmentId: bigint,
    mentorLogin: string,
    durationMinutes: number,
  ): Promise<void> {
    await prisma.client.guidanceRecord.create({
      data: {
        appointmentId,
        actualTime: new Date(`${YEAR}-06-20T02:00:00.000Z`),
        mode: 1,
        coreContent: 'P4 验收指导内容',
        followUp: 'P4 验收后续建议',
        submittedBy: personOf(mentorLogin),
        submittedAt: new Date(),
        durationMinutes,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
  }

  async function createAchievement(mentorId: bigint): Promise<void> {
    await prisma.client.achievement.create({
      data: {
        mentorId,
        type: 1,
        title: 'P4 验收省级金奖',
        level: 2,
        awardedAt: new Date(`${YEAR}-09-15T00:00:00.000Z`),
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
  }

  async function createAssessment(mentorId: bigint): Promise<void> {
    await prisma.client.assessment.create({
      data: {
        mentorId,
        period: YEAR,
        status: 2,
        collegeGrade: 2,
        finalGrade: 1,
        compositeScore: '90.00',
        finalReviewedAt: new Date(),
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
  }

  async function createApplication(): Promise<bigint> {
    const row = await prisma.client.mentorApplication.create({
      data: {
        type: 1,
        applicantId: personOf('m-a1'),
        profileId: profiles.get('a1') as bigint,
        snapshot: {},
        status: 4,
        submittedAt: new Date(),
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    return row.id;
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

  function dateOnlyInZone(now: Date, offsetDays: number): string {
    const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(now)
      .split('-')
      .map((part) => Number(part));
    return new Date(Date.UTC(year, month - 1, day + offsetDays))
      .toISOString()
      .slice(0, 10);
  }

  /** 检索用的日期是 UTC 日历日（与统计域 R70 同一口径） */
  function utcDate(offsetDays: number): string {
    const now = new Date();
    return new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + offsetDays,
      ),
    )
      .toISOString()
      .slice(0, 10);
  }

  // ── 正链 2–5：统计 ─────────────────────────────────────────────

  it('正链 2：GET /stats/mentors 各口径对得上', async () => {
    const response = await api('p4-sc').get('/stats/mentors').expect(200);
    const data = (response.body as ResponseEnvelope<MentorStatsResponseDto>)
      .data;

    expect(data).toMatchObject({
      total: 3,
      internal: 2,
      external: 1,
      active: 1,
      inactive: 2,
    });
    expect(data.byStatus).toEqual({
      draft: 0,
      pending: 0,
      approved: 3,
      rejected: 0,
      frozen: 0,
      removed: 0,
    });
    expect(data.byResearchField).toEqual([
      { field: '人工智能', count: 2 },
      { field: '创新创业', count: 1 },
    ]);
  });

  it('正链 3：GET /stats/appointments 十态齐全、两个比率对得上', async () => {
    const response = await api('p4-sc').get('/stats/appointments').expect(200);
    const data = (
      response.body as ResponseEnvelope<AppointmentStatsResponseDto>
    ).data;

    expect(data.total).toBe(8);
    expect(data.byStatus).toEqual([
      { status: 0, count: 1 },
      { status: 1, count: 1 },
      { status: 2, count: 0 },
      { status: 3, count: 0 },
      { status: 4, count: 0 },
      { status: 5, count: 0 },
      { status: 6, count: 2 },
      { status: 7, count: 2 },
      { status: 8, count: 1 },
      { status: 9, count: 1 },
    ]);
    expect(data.acceptanceRate).toBe(0.38);
    expect(data.completionRate).toBe(0.33);
    expect(data.failedPairs).toHaveLength(1);
    expect(data.failedPairs[0]).toMatchObject({
      studentPersonId: personOf('stu-a').toString(),
      mentorProfileId: profiles.get('a2')?.toString(),
      failedCount: 3,
    });
  });

  it('正链 4：GET /stats/guidance 次数 / 时长 / 学生数 / 成果数对得上', async () => {
    const response = await api('p4-sc')
      .get('/stats/guidance')
      .query({ period: YEAR })
      .expect(200);
    const data = (response.body as ResponseEnvelope<GuidanceStatsResponseDto>)
      .data;

    expect(data).toMatchObject({
      guidanceCount: 2,
      guidanceMinutes: 210,
      studentCount: 1,
      achievementCount: 1,
    });
    expect(data.byType).toEqual([
      { type: 1, count: 2, minutes: 210 },
      { type: 2, count: 0, minutes: 0 },
      { type: 3, count: 0, minutes: 0 },
      { type: 4, count: 0, minutes: 0 },
      { type: 5, count: 0, minutes: 0 },
    ]);
    expect(data.byMentor).toHaveLength(1);
    expect(data.byMentor[0]).toMatchObject({
      mentorProfileId: profiles.get('a1')?.toString(),
      guidanceCount: 2,
      guidanceMinutes: 210,
      studentCount: 1,
      achievementCount: 1,
    });
  });

  it('正链 4b：学生调 GET /stats/guidance 是范围收窄（200），不是 403', async () => {
    const response = await api('stu-a')
      .get('/stats/guidance')
      .query({ period: YEAR })
      .expect(200);
    const data = (response.body as ResponseEnvelope<GuidanceStatsResponseDto>)
      .data;

    // 学生没有导师档案：`self` 范围解析成「本人档案不存在」→ 空集
    expect(data).toMatchObject({
      guidanceCount: 0,
      guidanceMinutes: 0,
      studentCount: 0,
      achievementCount: 0,
    });
    expect(data.byMentor).toEqual([]);
  });

  it('正链 5：GET /stats/assessments 三个分布之和都等于 total', async () => {
    const response = await api('p4-sc')
      .get('/stats/assessments')
      .query({ period: YEAR })
      .expect(200);
    const data = (response.body as ResponseEnvelope<AssessmentStatsResponseDto>)
      .data;

    expect(data.total).toBe(1);
    expect(data.byGrade).toEqual({
      excellent: 1,
      qualified: 0,
      unqualified: 0,
    });
    expect(data.byDept.reduce((sum, row) => sum + row.total, 0)).toBe(1);
    expect(data.byMentorType.reduce((sum, row) => sum + row.total, 0)).toBe(1);
    expect(data.byResearchField).toEqual([
      {
        field: '人工智能',
        excellent: 1,
        qualified: 0,
        unqualified: 0,
        total: 1,
      },
    ]);
  });

  // ── 正链 6–7：导出 ─────────────────────────────────────────────

  it('正链 6a：导师名单导出——BOM + 表头 + 3 行', async () => {
    const response = await api('p4-sc')
      .get('/stats/mentors/export')
      .expect(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toMatch(
      /^attachment; filename="[A-Za-z0-9._-]+[.]csv"$/,
    );
    expect(response.text.charCodeAt(0)).toBe(0xfeff);
    const lines = response.text.slice(1).split(CSV_EOL);
    expect(lines[0]).toBe(
      '工号,姓名,导师类型,所属学院,职称,指导方向,档案状态,入驻时间',
    );
    expect(lines.filter((line) => line.length > 0)).toHaveLength(4);
  });

  it('正链 6b：预约名单导出——8 行', async () => {
    const response = await api('p4-sc')
      .get('/stats/appointments/export')
      .expect(200);
    expect(response.text.charCodeAt(0)).toBe(0xfeff);
    const lines = response.text.slice(1).split(CSV_EOL);
    expect(lines[0]).toBe(
      '预约ID,学生学号,学生姓名,导师姓名,预约类型,状态,期望指导时间,发起时间',
    );
    expect(lines.filter((line) => line.length > 0)).toHaveLength(9);
  });

  it('正链 6c：指导工作统计表——1 行', async () => {
    const response = await api('p4-sc')
      .get('/stats/guidance/export')
      .query({ period: YEAR })
      .expect(200);
    expect(response.text.charCodeAt(0)).toBe(0xfeff);
    const lines = response.text.slice(1).split(CSV_EOL);
    expect(lines[0]).toBe(
      '导师工号,导师姓名,所属学院,指导次数,指导时长(分钟),指导学生数,成果数',
    );
    expect(lines.filter((line) => line.length > 0)).toHaveLength(2);
    expect(lines[1]).toContain('m-a1');
    expect(lines[1]).toContain(',2,210,1,1');
  });

  it('正链 6d：考核结果表——1 行', async () => {
    const response = await api('p4-sc')
      .get('/stats/assessments/export')
      .query({ period: YEAR })
      .expect(200);
    expect(response.text.charCodeAt(0)).toBe(0xfeff);
    const lines = response.text.slice(1).split(CSV_EOL);
    expect(lines[0]).toBe(
      '导师工号,导师姓名,所属学院,考核周期,初评等级,终评等级,综合得分,生效时间',
    );
    expect(lines.filter((line) => line.length > 0)).toHaveLength(2);
    expect(lines[1]).toContain('m-a1');
    expect(lines[1]).toContain('90.00');
  });

  it('正链 7：学生个人档案导出——只有自己的 2 条已完成预约', async () => {
    const response = await api('stu-a').get('/me/records/export').expect(200);
    expect(response.text.charCodeAt(0)).toBe(0xfeff);
    const lines = response.text.slice(1).split(CSV_EOL);
    expect(lines[0]).toBe(
      '预约ID,导师姓名,预约类型,指导主题,实际指导时间,指导时长(分钟),我的评分,我的评价',
    );
    const dataLines = lines.filter((line) => line.length > 0);
    expect(dataLines).toHaveLength(3);
    for (const line of dataLines.slice(1)) {
      expect(line).toContain('P4 验收预约');
    }
  });

  // ── 正链 8–10：归档 ───────────────────────────────────────────

  it('正链 8：入驻审核通过 → 自动归档出现', async () => {
    await api('p4-sc')
      .post(`/mentor-applications/${applicationId.toString()}/sc-review`)
      .send({ decision: 'approve', comment: '验收通过' })
      .expect(200);

    const row = await prisma.client.archiveItem.findFirst({
      where: {
        targetType: 'MentorApplication',
        targetId: applicationId.toString(),
      },
    });
    expect(row).toMatchObject({
      category: 'mentor-application',
      core: 1,
      mentorId: profiles.get('a1'),
      deptId: dept('A'),
      retentionUntil: null,
    });
  });

  it('正链 9：GET /archives 按 mentorId / category / 时间段检索', async () => {
    const byMentor = await api('p4-sc')
      .get('/archives')
      .query({ mentorId: profiles.get('a1')?.toString() })
      .expect(200);
    expect(
      (byMentor.body as ResponseEnvelope<ArchiveListResponseDto>).data.total,
    ).toBe(1);

    const byCategory = await api('p4-sc')
      .get('/archives')
      .query({ category: 'mentor-application' })
      .expect(200);
    expect(
      (byCategory.body as ResponseEnvelope<ArchiveListResponseDto>).data.total,
    ).toBe(1);

    const today = utcDate(0);
    const byDate = await api('p4-sc')
      .get('/archives')
      .query({ from: today, to: today })
      .expect(200);
    expect(
      (byDate.body as ResponseEnvelope<ArchiveListResponseDto>).data.total,
    ).toBe(1);
  });

  it('正链 10：POST /archives/purge 只清非核心过期项，SysFile 仍在', async () => {
    const today = dateOnlyInZone(new Date(), 0);
    const yesterday = dateOnlyInZone(new Date(), -1);
    const tenYearsAgo = dateOnlyInZone(new Date(), -3650);

    const core = await prisma.client.archiveItem.findFirst({
      where: {
        targetType: 'MentorApplication',
        targetId: applicationId.toString(),
      },
    });
    if (core === null) {
      throw new Error('正链 8 没有落下自动归档');
    }
    await prisma.client.archiveItem.update({
      where: { id: core.id },
      data: { retentionUntil: new Date(`${tenYearsAgo}T00:00:00.000Z`) },
    });

    const expiredId = await createManualArchive('flow-expired', '过期材料');
    await api('p4-sc')
      .patch(`/archives/${expiredId}`)
      .send({ retentionUntil: yesterday })
      .expect(200);
    const todayId = await createManualArchive('flow-today', '今天到期');
    await api('p4-sc')
      .patch(`/archives/${todayId}`)
      .send({ retentionUntil: today })
      .expect(200);

    const file = await prisma.client.sysFile.create({
      data: {
        originName: '验收佐证.pdf',
        storageName: 'p4-proof.pdf',
        ext: 'pdf',
        mimeType: 'application/pdf',
        size: 1,
        sha256: '1'.repeat(64),
        createdBy: 0n,
        updatedBy: 0n,
      },
    });

    const response = await api('p4-sc').post('/archives/purge').expect(200);
    expect(
      (response.body as ResponseEnvelope<{ purged: number }>).data,
    ).toEqual({ purged: 1 });

    const coreAfter = await prisma.client.archiveItem.findFirst({
      where: { id: core.id },
    });
    expect(coreAfter?.deletedAt).toBeNull();
    const todayAfter = await prisma.client.archiveItem.findFirst({
      where: { id: BigInt(todayId) },
    });
    expect(todayAfter?.deletedAt).toBeNull();
    const expiredAfter = await prisma.client.archiveItem.findFirst({
      where: { id: BigInt(expiredId) },
    });
    expect(expiredAfter?.deletedAt).not.toBeNull();
    const fileAfter = await prisma.client.sysFile.findFirst({
      where: { id: file.id },
    });
    expect(fileAfter).not.toBeNull();

    const second = await api('p4-sc').post('/archives/purge').expect(200);
    expect((second.body as ResponseEnvelope<{ purged: number }>).data).toEqual({
      purged: 0,
    });

    // N8：清理后同一目标可再归档
    await api('p4-sc')
      .post('/archives')
      .send({
        targetType: 'Other',
        targetId: 'flow-expired',
        title: '清理后再归档',
        category: 'other',
      })
      .expect(201);
  });

  // ── 负路径 N1–N6 ──────────────────────────────────────────────

  it('N1：学生调 /stats/mentors → 403 / 10003', async () => {
    const response = await api('stu-a').get('/stats/mentors').expect(403);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  it('N2：学院管理员传他院 deptId → 403 / 10003', async () => {
    const response = await api('p4-college-a')
      .get('/stats/mentors')
      .query({ deptId: dept('B').toString() })
      .expect(403);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  it('N3：period 与 from 同传 → 400 / 10001', async () => {
    const response = await api('p4-sc')
      .get('/stats/mentors')
      .query({ period: YEAR, from: `${YEAR}-01-01` })
      .expect(400);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PARAM_INVALID,
    );
  });

  it('N4：export.max_rows = 2 造 3 行 → 409 / 37004，不返回半份 CSV', async () => {
    await prisma.client.sysConfig.create({
      data: {
        code: 'export.max_rows',
        name: '导出上限（P4 验收）',
        value: '2',
        valueType: 'number',
        status: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    try {
      const response = await api('p4-sc')
        .get('/stats/mentors/export')
        .expect(409);
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

  it('N5：重复手工归档 → 409 / 37002', async () => {
    await api('p4-sc')
      .post('/archives')
      .send({
        targetType: 'Other',
        targetId: 'flow-dup',
        title: '重复归档',
        category: 'other',
      })
      .expect(201);
    const response = await api('p4-sc')
      .post('/archives')
      .send({
        targetType: 'Other',
        targetId: 'flow-dup',
        title: '重复归档',
        category: 'other',
      })
      .expect(409);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.ARCHIVE_ALREADY_EXISTS,
    );
  });

  it('N6：手工归档带 core → 400 / 10001', async () => {
    const response = await api('p4-sc')
      .post('/archives')
      .send({
        targetType: 'Other',
        targetId: 'flow-core',
        title: '冒充核心',
        category: 'other',
        core: 1,
      })
      .expect(400);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PARAM_INVALID,
    );
  });

  async function createManualArchive(
    targetId: string,
    title: string,
  ): Promise<string> {
    const response = await api('p4-sc')
      .post('/archives')
      .send({
        targetType: 'Other',
        targetId,
        title,
        category: 'other',
        mentorId: profiles.get('a1')?.toString(),
        deptId: dept('A').toString(),
      })
      .expect(201);
    return (response.body as ResponseEnvelope<ArchiveResponseDto>).data.id;
  }
});

async function clearFlowTables(prisma: PrismaService): Promise<void> {
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
