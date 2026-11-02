import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { runWithSyncWrite } from '../src/infra/prisma/sync-write-scope';
import { ErrorCode } from '../src/common/constants/error-code';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import { currentPeriod } from '../src/modules/assessment/assessment.constants';
import type { AssessmentResponseDto } from '../src/modules/assessment/dto/assessment-response.dto';
import type { AssessmentStatsResponseDto } from '../src/modules/stats/dto/assessment-stats.dto';
import type { MessageListResponseDto } from '../src/modules/message/dto/message-response.dto';
import type { WorkProgressResponseDto } from '../src/modules/message/dto/work-progress.dto';
import type {
  StudentAchievementListResponseDto,
  StudentAchievementResponseDto,
} from '../src/modules/student-achievement/dto/student-achievement-response.dto';
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
const PERIOD = currentPeriod();
const AWARDED_AT = PERIOD.endsWith('-1')
  ? `${PERIOD.slice(0, 4)}-05-01`
  : `${PERIOD.slice(0, 4)}-11-01`;

/**
 * P5 端到端验收（Task 61）：学期考核 → 工作进度 → 提醒已读 → 规则 →
 * 学生成果关联 → 实践学时数据源 → 删除联动。
 */
describe('P5 端到端验收（提醒 + 学期 + 成果关联）(e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const agents = new Map<string, E2eApi>();
  const permissionIds = new Map<string, bigint>();
  const deptIds = new Map<string, bigint>();
  const people = new Map<string, bigint>();
  const profiles = new Map<string, bigint>();
  const userIds = new Map<string, bigint>();

  let assessmentAId: bigint;
  let studentAchievementId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);

    await clearP5Tables(prisma);
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
    deptIds.set('A', await createDept('P5 A 学院', rootDept.id));
    deptIds.set('B', await createDept('P5 B 学院', rootDept.id));

    const orgA = await createOrg('ORG-P5-A', 'P5 A 组织', dept('A'));
    const orgB = await createOrg('ORG-P5-B', 'P5 B 组织', dept('B'));

    for (const [login, personType, orgUnitId] of [
      ['p5-mentor-a', 'internalMentor', orgA],
      ['p5-mentor-b', 'internalMentor', orgB],
      ['p5-student-a', 'student', orgA],
      ['p5-student-b', 'student', orgB],
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
    profiles.set('a', await createProfile('p5-mentor-a'));
    profiles.set('b', await createProfile('p5-mentor-b'));

    // A 导师：1 条待确认 + 1 条逾期未填记录 + 当前学期待处理考核
    await createAppointment('p5-student-a', 'a', 0, 1);
    await createAppointment('p5-student-a', 'a', 1, 2, true);

    const scRole = await createRole('P5 双创学院', 'p5_sc', 'all', [
      'assessment:evaluate',
      'assessment:list',
      'assessment:finalize',
      'stats:assessment',
      'assessment:rule-manage',
      'work:progress',
      'reminder:send',
      'message:list',
      'student-achievement:list',
    ]);
    const collegeRole = await createRole(
      'P5 学院管理员',
      'p5_college',
      'deptAndChildren',
      [
        'assessment:evaluate',
        'assessment:list',
        'stats:assessment',
        'work:progress',
        'reminder:send',
        'message:list',
        'student-achievement:manage',
        'student-achievement:list',
      ],
    );
    const mentorRole = await createRole('P5 导师', 'p5_mentor', 'self', [
      'message:list',
      'student-achievement:list',
    ]);
    const studentRole = await createRole('P5 学生', 'p5_student', 'self', [
      'message:list',
      'student-achievement:list',
    ]);

    for (const [username, roleId, deptKey] of [
      ['p5-sc', scRole, 'root'],
      ['p5-college-a', collegeRole, 'A'],
      ['p5-mentor-a', mentorRole, 'A'],
      ['p5-student-a', studentRole, 'A'],
    ] as const) {
      const user = await seedUser(prisma, { username, deptId: dept(deptKey) });
      userIds.set(username, user.userId);
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
        await clearP5Tables(prisma);
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

  async function createProfile(login: string): Promise<bigint> {
    const row = await prisma.client.mentorProfile.create({
      data: {
        personId: personOf(login),
        researchFields: [],
        status: 2,
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
    overdue = false,
  ): Promise<bigint> {
    const row = await prisma.client.appointment.create({
      data: {
        studentPersonId: personOf(studentLogin),
        mentorProfileId: profiles.get(mentorKey) as bigint,
        type: 1,
        status,
        requestedTime: overdue
          ? new Date(Date.now() - 86_400_000)
          : new Date(`2026-06-0${day}T02:00:00.000Z`),
        topic: `P5 验收预约 ${day}`,
        questions: 'P5 验收夹具',
        mode: 1,
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
        name: `P5 ${code}`,
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

  function studentBody(overrides: Record<string, unknown> = {}) {
    return {
      studentPersonId: personOf('p5-student-a').toString(),
      type: 1,
      title: 'P5 验收省级金奖',
      level: 2,
      awardedAt: AWARDED_AT,
      ...overrides,
    };
  }

  it('正链 1：建当前学期考核 → 列表命中', async () => {
    const created = await api('p5-college-a')
      .post('/assessments')
      .send({ mentorId: profiles.get('a')?.toString(), period: PERIOD })
      .expect(201);
    assessmentAId = BigInt(
      (created.body as ResponseEnvelope<AssessmentResponseDto>).data.id,
    );

    const list = await api('p5-college-a')
      .get('/assessments')
      .query({ period: PERIOD })
      .expect(200);
    expect((list.body as ResponseEnvelope<{ total: number }>).data.total).toBe(
      1,
    );
  });

  it('正链 2：工作进度三个计数', async () => {
    const response = await api('p5-college-a')
      .get('/work-progress')
      .expect(200);
    const data = (response.body as ResponseEnvelope<WorkProgressResponseDto>)
      .data;

    expect(data).toMatchObject({
      totalMentors: 1,
      pendingAppointments: 1,
      missingRecords: 1,
      pendingAssessments: 1,
    });
  });

  it('正链 3：发提醒 → 导师收到 → 标记已读', async () => {
    const sent = await api('p5-college-a')
      .post('/reminders')
      .send({ type: 'pending-appointments' })
      .expect(201);
    expect(
      (sent.body as ResponseEnvelope<{ sent: number; skipped: number }>).data,
    ).toEqual({ sent: 1, skipped: 0 });

    const inbox = await api('p5-mentor-a').get('/messages').expect(200);
    const inboxData = (inbox.body as ResponseEnvelope<MessageListResponseDto>)
      .data;
    expect(inboxData.total).toBe(1);
    expect(inboxData.unread).toBe(1);

    const read = await api('p5-mentor-a')
      .patch(`/messages/${inboxData.list[0]?.id}/read`)
      .expect(200);
    expect(
      (read.body as ResponseEnvelope<{ readAt: string }>).data.readAt,
    ).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const after = await api('p5-mentor-a').get('/messages').expect(200);
    expect(
      (after.body as ResponseEnvelope<MessageListResponseDto>).data.unread,
    ).toBe(0);
  });

  it('正链 4：改评分规则 → 新考核冻结新权重', async () => {
    await api('p5-sc')
      .put('/assessments/rules')
      .send({
        weights: { review: 0.5, workload: 0.3, achievement: 0.2 },
        targets: { workload: 20, achievement: 10 },
      })
      .expect(200);

    const created = await api('p5-sc')
      .post('/assessments')
      .send({ mentorId: profiles.get('b')?.toString(), period: PERIOD })
      .expect(201);
    const data = (created.body as ResponseEnvelope<AssessmentResponseDto>).data;
    expect(data.weights).toEqual({
      review: 0.5,
      workload: 0.3,
      achievement: 0.2,
      normalized: false,
    });
  });

  it('正链 5：学生成果关联 → 导师成果 + 考核指标 + 归档', async () => {
    const response = await api('p5-college-a')
      .post('/student-achievements')
      .send(studentBody({ mentorProfileId: profiles.get('a')?.toString() }))
      .expect(201);
    const data = (
      response.body as ResponseEnvelope<StudentAchievementResponseDto>
    ).data;
    studentAchievementId = data.id;

    expect(data.mentorProfileId).toBe(profiles.get('a')?.toString());
    expect(data.achievementId).not.toBeNull();

    const assessment = await api('p5-college-a')
      .get(`/assessments/${assessmentAId.toString()}`)
      .expect(200);
    expect(
      (assessment.body as ResponseEnvelope<AssessmentResponseDto>).data.metrics
        .achievementCount,
    ).toBe(1);

    const archive = await prisma.client.archiveItem.findFirst({
      where: { targetType: 'StudentAchievement', targetId: data.id },
    });
    expect(archive).toMatchObject({ category: 'achievement', core: 0 });
  });

  it('正链 5b：初评 + 终评生效 → 考核统计命中', async () => {
    await api('p5-college-a')
      .post(`/assessments/${assessmentAId.toString()}/college-review`)
      .send({ grade: 2, comment: 'P5 验收初评' })
      .expect(200);
    await api('p5-sc')
      .post(`/assessments/${assessmentAId.toString()}/final-review`)
      .send({ decision: 'approve', grade: 1, comment: 'P5 验收终评' })
      .expect(200);

    const stats = await api('p5-college-a')
      .get('/stats/assessments')
      .query({ period: PERIOD })
      .expect(200);
    expect(
      (stats.body as ResponseEnvelope<AssessmentStatsResponseDto>).data.total,
    ).toBe(1);
  });

  it('正链 6：学生按本人检索（实践学时档案数据源）', async () => {
    const response = await api('p5-student-a')
      .get('/student-achievements')
      .expect(200);
    const data = (
      response.body as ResponseEnvelope<StudentAchievementListResponseDto>
    ).data;
    expect(data.total).toBe(1);
    expect(data.list[0]?.studentPersonId).toBe(
      personOf('p5-student-a').toString(),
    );
  });

  it('正链 7：删除学生成果 → 导师成果与归档联动软删', async () => {
    await api('p5-college-a')
      .delete(`/student-achievements/${studentAchievementId}`)
      .expect(200);

    expect(
      await prisma.client.achievement.count({
        where: { mentorId: profiles.get('a') },
      }),
    ).toBe(0);
    expect(
      await prisma.client.archiveItem.findFirst({
        where: {
          targetType: 'StudentAchievement',
          targetId: studentAchievementId,
        },
      }),
    ).toBeNull();

    const list = await api('p5-student-a')
      .get('/student-achievements')
      .expect(200);
    expect(
      (list.body as ResponseEnvelope<StudentAchievementListResponseDto>).data
        .total,
    ).toBe(0);
  });

  // ── 负路径 ────────────────────────────────────────────────────

  it('N1：学生调 /work-progress → 403 / 10003', async () => {
    const response = await api('p5-student-a')
      .get('/work-progress')
      .expect(403);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  it('N2：学院管理员给外院导师发提醒 → 403 / 10003', async () => {
    const response = await api('p5-college-a')
      .post('/reminders')
      .send({
        type: 'pending-appointments',
        mentorProfileIds: [profiles.get('b')?.toString()],
      })
      .expect(403);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  it('N3：重复 link → 409 / 39002', async () => {
    const created = await api('p5-college-a')
      .post('/student-achievements')
      .send(studentBody({ title: 'P5 待关联成果' }))
      .expect(201);
    const id = (created.body as ResponseEnvelope<StudentAchievementResponseDto>)
      .data.id;

    await api('p5-college-a')
      .patch(`/student-achievements/${id}/link`)
      .send({ mentorProfileId: profiles.get('a')?.toString() })
      .expect(200);

    const response = await api('p5-college-a')
      .patch(`/student-achievements/${id}/link`)
      .send({ mentorProfileId: profiles.get('a')?.toString() })
      .expect(409);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.STUDENT_ACHIEVEMENT_ALREADY_LINKED,
    );
  });

  it('N4：学生调 POST /student-achievements → 403 / 10003', async () => {
    const response = await api('p5-student-a')
      .post('/student-achievements')
      .send(studentBody({ title: '越权成果' }))
      .expect(403);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  it('N5：非法学期 2026-3 → 400 / 10001', async () => {
    const response = await api('p5-college-a')
      .post('/assessments')
      .send({ mentorId: profiles.get('a')?.toString(), period: '2026-3' })
      .expect(400);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PARAM_INVALID,
    );
  });

  it('N6：权重全 0 → 400 / 10001', async () => {
    const response = await api('p5-sc')
      .put('/assessments/rules')
      .send({ weights: { review: 0, workload: 0, achievement: 0 } })
      .expect(400);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PARAM_INVALID,
    );
  });
});

async function clearP5Tables(prisma: PrismaService): Promise<void> {
  await prisma.includingDeleted.studentAchievement.deleteMany({});
  await prisma.includingDeleted.message.deleteMany({});
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
