import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { runWithSyncWrite } from '../src/infra/prisma/sync-write-scope';
import { ErrorCode } from '../src/common/constants/error-code';
import { currentPeriod } from '../src/modules/assessment/assessment.constants';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import type {
  AppealListResponseDto,
  AppealResponseDto,
} from '../src/modules/assessment/dto/appeal-response.dto';
import type {
  AssessmentListResponseDto,
  AssessmentResponseDto,
} from '../src/modules/assessment/dto/assessment-response.dto';
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

/**
 * 考核的开与初评（P3 Task 39）。
 *
 * 状态机、冻结、部门范围各钉一条；`status = 0` 与 `status = 1` 的指标来源不同
 * （实时 vs 冻结），这里只验「提交后确实落库」，冻结不变性留给 Task 41 的 GET。
 */
describe('考核：开考核与提交初评（P3 Task 39）(e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const agents = new Map<string, E2eApi>();
  const permissionIds = new Map<string, bigint>();
  const people = new Map<string, bigint>();
  const deptIds = new Map<string, bigint>();
  let mentorAId: bigint;
  let mentorBId: bigint;
  let mentorCId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);

    await clearAssessmentTables(prisma);
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
    deptIds.set('A', await createDept('考核学院 A', rootDept.id));
    deptIds.set('B', await createDept('考核学院 B', rootDept.id));

    const orgA = await createOrg('ORG-ASM-A', '考核 A 组织', dept('A'));
    const orgB = await createOrg('ORG-ASM-B', '考核 B 组织', dept('B'));

    for (const [login, realName, orgUnitId] of [
      ['asm-mentor-a', '考核导师甲', orgA],
      ['asm-mentor-b', '考核导师乙', orgB],
      ['asm-student', '考核学生', orgA],
      ['asm-mentor-c', '验收导师丙', orgA],
    ] as const) {
      const person = await runWithSyncWrite(() =>
        prisma.client.syncPerson.create({
          data: {
            login,
            realName,
            personType: login === 'asm-student' ? 'student' : 'internalMentor',
            orgUnitId,
            syncedAt: SYNCED_AT,
            createdBy: 0n,
            updatedBy: 0n,
          },
        }),
      );
      people.set(login, person.id);
    }

    mentorAId = (
      await prisma.client.mentorProfile.create({
        data: {
          personId: personOf('asm-mentor-a'),
          researchFields: ['创新创业'],
          status: 2,
          createdBy: 0n,
          updatedBy: 0n,
        },
      })
    ).id;
    mentorBId = (
      await prisma.client.mentorProfile.create({
        data: {
          personId: personOf('asm-mentor-b'),
          researchFields: ['智能制造'],
          status: 2,
          createdBy: 0n,
          updatedBy: 0n,
        },
      })
    ).id;
    // 验收链路专用的第三个导师：前两个的 2026 周期已被前面的判据占用
    mentorCId = (
      await prisma.client.mentorProfile.create({
        data: {
          personId: personOf('asm-mentor-c'),
          researchFields: ['创新创业'],
          status: 2,
          createdBy: 0n,
          updatedBy: 0n,
        },
      })
    ).id;

    const collegeRole = await createRole(
      '考核学院管理员',
      'asm_college',
      'dept',
      ['assessment:list', 'assessment:evaluate'],
    );
    const mentorRole = await createRole('考核导师', 'asm_mentor', 'self', [
      'assessment:list',
      'assessment:appeal',
      'achievement:manage',
    ]);
    const studentRole = await createRole('考核学生', 'asm_student', 'self', [
      'review:create',
      'review:list',
    ]);
    const scRole = await createRole('考核双创学院', 'asm_sc', 'all', [
      'assessment:list',
      'assessment:finalize',
      'assessment:appeal-handle',
    ]);

    const users: Array<[string, bigint, bigint]> = [
      ['asm-college', collegeRole, dept('A')],
      ['asm-mentor-a', mentorRole, dept('A')],
      ['asm-mentor-b', mentorRole, dept('B')],
      ['asm-sc', scRole, dept('root')],
      // B 院也需要一个学院管理员：`dept` 范围只管自己那一层，
      // A 院管理员给 B 院导师提交初评会被 403（判据 9 钉的正是这条）
      ['asm-college-b', collegeRole, dept('B')],
      ['asm-student', studentRole, dept('A')],
      ['asm-mentor-c', mentorRole, dept('A')],
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
        await clearAssessmentTables(prisma);
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

  async function ensurePermissionId(code: string): Promise<bigint> {
    const cached = permissionIds.get(code);
    if (cached !== undefined) {
      return cached;
    }
    const row = await prisma.client.sysPermission.create({
      data: {
        type: 'BUTTON',
        code,
        name: `P3 ${code}`,
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

  it('判据 1：学院为本院导师开考核 → 201、status = 0、指标为实时试算', async () => {
    const response = await api('asm-college')
      .post('/assessments')
      .send({ mentorId: mentorAId.toString(), period: '2026-1' })
      .expect(201);

    const data = (response.body as ResponseEnvelope<AssessmentResponseDto>)
      .data;
    expect(data).toMatchObject({
      mentorProfileId: mentorAId.toString(),
      period: '2026-1',
      status: 0,
      collegeGrade: null,
      finalGrade: null,
    });
    // 空集：无评价时 reviewAvg 是 null，不是 "0.00"
    expect(data.metrics.reviewAvg).toBeNull();
    expect(data.metrics.reviewCount).toBe(0);
    expect(data.metrics.compositeScore).toBe('0.00');
    expect(data.weights).toEqual({
      review: 0.4,
      workload: 0.4,
      achievement: 0.2,
      normalized: false,
    });
  });

  it('判据 2：同导师同周期再开 → 409 / 35003', async () => {
    const response = await api('asm-college')
      .post('/assessments')
      .send({ mentorId: mentorAId.toString(), period: '2026-1' })
      .expect(409);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.ASSESSMENT_PERIOD_TAKEN,
    );
  });

  it('判据 3：给跨院导师开考核 → 403 / 10003', async () => {
    const response = await api('asm-college')
      .post('/assessments')
      .send({ mentorId: mentorBId.toString(), period: '2026-1' })
      .expect(403);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  it('判据 4：导师档案不存在 → 404 / 31102', async () => {
    const response = await api('asm-college')
      .post('/assessments')
      .send({ mentorId: '999999', period: '2026-1' })
      .expect(404);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.MENTOR_PROFILE_NOT_FOUND,
    );
  });

  it('判据 5：period 不是学期 YYYY-S → 400 / 10001', async () => {
    for (const period of ['2026', '26', '2026-3', '2026-2027-1']) {
      const response = await api('asm-college')
        .post('/assessments')
        .send({ mentorId: mentorAId.toString(), period })
        .expect(400);
      expect((response.body as ResponseEnvelope<null>).code).toBe(
        ErrorCode.PARAM_INVALID,
      );
    }
  });

  it('判据 6：提交初评 → 200、status = 1、等级与意见落库、指标整组冻结', async () => {
    const list = await prisma.client.assessment.findFirst({
      where: { mentorId: mentorAId, period: '2026-1' },
    });
    if (list === null) {
      throw new Error('判据 1 的考核不见了');
    }

    const response = await api('asm-college')
      .post(`/assessments/${list.id.toString()}/college-review`)
      .send({ grade: 2, comment: '本年度指导工作达标，评价良好。' })
      .expect(200);

    const data = (response.body as ResponseEnvelope<AssessmentResponseDto>)
      .data;
    expect(data.status).toBe(1);
    expect(data.collegeGrade).toBe(2);
    expect(data.collegeComment).toBe('本年度指导工作达标，评价良好。');
    expect(data.collegeSubmittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // 落库的是**冻结值**，不是响应现算的
    const row = await prisma.client.assessment.findFirst({
      where: { id: list.id },
    });
    expect(row?.status).toBe(1);
    expect(row?.collegeGrade).toBe(2);
    expect(row?.weights).toEqual({
      review: 0.4,
      workload: 0.4,
      achievement: 0.2,
      normalized: false,
    });
    // 6 个指标 + compositeScore 都非空（空集也是 0，不是 null）
    expect(row?.reviewCount).toBe(0);
    expect(row?.guidanceCount).toBe(0);
    expect(row?.guidanceMinutes).toBe(0);
    expect(row?.studentCount).toBe(0);
    expect(row?.achievementCount).toBe(0);
    // Decimal 的 toString() 会省掉尾零（"0" 而不是 "0.00"），按数值比较
    expect(Number(row?.compositeScore)).toBe(0);
    expect(row?.reviewAvg).toBeNull();
  });

  it('判据 7：status = 1 时再提交初评 → 409 / 35002', async () => {
    const row = await prisma.client.assessment.findFirst({
      where: { mentorId: mentorAId, period: '2026-1' },
    });
    if (row === null) {
      throw new Error('考核不见了');
    }

    const response = await api('asm-college')
      .post(`/assessments/${row.id.toString()}/college-review`)
      .send({ grade: 1, comment: '再评一次' })
      .expect(409);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.ASSESSMENT_TRANSITION_INVALID,
    );
  });

  it('判据 8：退回（status = 3）后可再提交 → 200，等级被覆盖', async () => {
    const row = await prisma.client.assessment.findFirst({
      where: { mentorId: mentorAId, period: '2026-1' },
    });
    if (row === null) {
      throw new Error('考核不见了');
    }
    // 模拟双创学院退回（Task 40 的终评 `return` 会做同一件事）
    await prisma.client.assessment.update({
      where: { id: row.id },
      data: { status: 3, finalComment: '材料不全，请补充后重评' },
    });

    const response = await api('asm-college')
      .post(`/assessments/${row.id.toString()}/college-review`)
      .send({ grade: 1, comment: '补充材料后重评：本年度表现优秀。' })
      .expect(200);

    const data = (response.body as ResponseEnvelope<AssessmentResponseDto>)
      .data;
    expect(data.status).toBe(1);
    expect(data.collegeGrade).toBe(1);
    expect(data.collegeComment).toBe('补充材料后重评：本年度表现优秀。');
  });

  it('判据 9：跨院考核提交初评 → 403 / 10003', async () => {
    // 给 B 院导师直接建一条考核（绕过 API，因为 API 会先被部门范围挡住）
    const row = await prisma.client.assessment.create({
      data: {
        mentorId: mentorBId,
        period: '2026-1',
        createdBy: 0n,
        updatedBy: 0n,
      },
    });

    const response = await api('asm-college')
      .post(`/assessments/${row.id.toString()}/college-review`)
      .send({ grade: 2, comment: '越权提交' })
      .expect(403);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  // ── 终评（Task 40）────────────────────────────────────────────────

  it('判据 10：approve 且终评等级不同于初评 → status = 2，两列各留各的值（R54）', async () => {
    const row = await prisma.client.assessment.findFirst({
      where: { mentorId: mentorAId, period: '2026-1' },
    });
    if (row === null) {
      throw new Error('考核不见了');
    }
    expect(row.status).toBe(1);
    expect(row.collegeGrade).toBe(1);

    const response = await api('asm-sc')
      .post(`/assessments/${row.id.toString()}/final-review`)
      .send({
        decision: 'approve',
        grade: 3,
        comment: '全校横向对比后定为不合格。',
      })
      .expect(200);

    const data = (response.body as ResponseEnvelope<AssessmentResponseDto>)
      .data;
    expect(data.status).toBe(2);
    // 终评**不覆盖**初评：学院填的是 1，双创学院定的是 3
    expect(data.collegeGrade).toBe(1);
    expect(data.finalGrade).toBe(3);
    expect(data.finalComment).toBe('全校横向对比后定为不合格。');
    expect(data.finalReviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const after = await prisma.client.assessment.findFirst({
      where: { id: row.id },
    });
    expect(after?.status).toBe(2);
    expect(after?.collegeGrade).toBe(1);
    expect(after?.finalGrade).toBe(3);
  });

  it('判据 11：status = 2 时再终评 → 409 / 35002', async () => {
    const row = await prisma.client.assessment.findFirst({
      where: { mentorId: mentorAId, period: '2026-1' },
    });
    if (row === null) {
      throw new Error('考核不见了');
    }

    const response = await api('asm-sc')
      .post(`/assessments/${row.id.toString()}/final-review`)
      .send({ decision: 'approve', grade: 2, comment: '再评一次' })
      .expect(409);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.ASSESSMENT_TRANSITION_INVALID,
    );
  });

  it('判据 12：approve 缺 grade → 400 / 10001', async () => {
    const row = await prisma.client.assessment.findFirst({
      where: { mentorId: mentorBId, period: '2026-1' },
    });
    if (row === null) {
      throw new Error('B 院考核不见了');
    }
    await prisma.client.assessment.update({
      where: { id: row.id },
      data: { status: 1, collegeGrade: 2, collegeComment: 'B 院初评' },
    });

    const response = await api('asm-sc')
      .post(`/assessments/${row.id.toString()}/final-review`)
      .send({ decision: 'approve', comment: '缺等级' })
      .expect(400);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PARAM_INVALID,
    );
  });

  it('判据 13：return 带 grade → 400 / 10001（退回还定级是自相矛盾的输入）', async () => {
    const row = await prisma.client.assessment.findFirst({
      where: { mentorId: mentorBId, period: '2026-1' },
    });
    if (row === null) {
      throw new Error('B 院考核不见了');
    }

    const response = await api('asm-sc')
      .post(`/assessments/${row.id.toString()}/final-review`)
      .send({ decision: 'return', grade: 2, comment: '材料不全' })
      .expect(400);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PARAM_INVALID,
    );
  });

  it('判据 14：return 成功 → status = 3，finalGrade 置 null（不沿用旧值）', async () => {
    const row = await prisma.client.assessment.findFirst({
      where: { mentorId: mentorBId, period: '2026-1' },
    });
    if (row === null) {
      throw new Error('B 院考核不见了');
    }

    const response = await api('asm-sc')
      .post(`/assessments/${row.id.toString()}/final-review`)
      .send({ decision: 'return', comment: '材料不全，请补充后重评' })
      .expect(200);

    const data = (response.body as ResponseEnvelope<AssessmentResponseDto>)
      .data;
    expect(data.status).toBe(3);
    expect(data.finalGrade).toBeNull();
    expect(data.finalComment).toBe('材料不全，请补充后重评');

    const after = await prisma.client.assessment.findFirst({
      where: { id: row.id },
    });
    expect(after?.status).toBe(3);
    expect(after?.finalGrade).toBeNull();
  });

  it('判据 15：退回后学院可再提交（3 → 1），终评字段仍在但状态回到待终评', async () => {
    const row = await prisma.client.assessment.findFirst({
      where: { mentorId: mentorBId, period: '2026-1' },
    });
    if (row === null) {
      throw new Error('B 院考核不见了');
    }

    const response = await api('asm-college-b')
      .post(`/assessments/${row.id.toString()}/college-review`)
      .send({ grade: 2, comment: '补充材料后重评：合格。' })
      .expect(200);

    const data = (response.body as ResponseEnvelope<AssessmentResponseDto>)
      .data;
    expect(data.status).toBe(1);
    expect(data.collegeGrade).toBe(2);
  });

  // ── 查询（Task 41）────────────────────────────────────────────────

  it('判据 16：列表三视角——导师 1 条 / A 院 1 条 / 双创学院 2 条', async () => {
    const mentorList = await api('asm-mentor-a')
      .get('/assessments')
      .expect(200);
    const mentorData = (
      mentorList.body as ResponseEnvelope<AssessmentListResponseDto>
    ).data;
    expect(mentorData.total).toBe(1);
    expect(mentorData.list[0].mentorProfileId).toBe(mentorAId.toString());

    const collegeList = await api('asm-college')
      .get('/assessments')
      .expect(200);
    const collegeData = (
      collegeList.body as ResponseEnvelope<AssessmentListResponseDto>
    ).data;
    expect(collegeData.total).toBe(1);

    const scList = await api('asm-sc').get('/assessments').expect(200);
    const scData = (scList.body as ResponseEnvelope<AssessmentListResponseDto>)
      .data;
    expect(scData.total).toBe(2);
  });

  it('判据 17：已提交的考核回冻结值——补一条评价后数字不变（R55 可伪性）', async () => {
    const row = await prisma.client.assessment.findFirst({
      where: { mentorId: mentorAId, period: '2026-1' },
    });
    if (row === null) {
      throw new Error('考核不见了');
    }
    expect(row.reviewCount).toBe(0);

    // 造一条 2026 年内、属于该导师的已完成预约 + 评价
    const appointment = await prisma.client.appointment.create({
      data: {
        studentPersonId: personOf('asm-student'),
        mentorProfileId: mentorAId,
        type: 1,
        status: 6,
        requestedTime: new Date('2026-06-01T02:00:00.000Z'),
        topic: '冻结可伪性用例',
        questions: '这条预约只用于证明冻结值不会被新评价改动',
        mode: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    await prisma.client.studentReview.create({
      data: {
        appointmentId: appointment.id,
        attitude: 5,
        expertise: 5,
        effect: 5,
        overallScore: '5.00',
        createdBy: 0n,
        updatedBy: 0n,
      },
    });

    const response = await api('asm-college')
      .get(`/assessments/${row.id.toString()}`)
      .expect(200);
    const data = (response.body as ResponseEnvelope<AssessmentResponseDto>)
      .data;

    // 若这里改成实时计算，reviewCount 会变成 1、reviewAvg 会变成 "5.00"
    expect(data.metrics.reviewCount).toBe(0);
    expect(data.metrics.reviewAvg).toBeNull();
  });

  it('判据 18：跨院考核详情 → 403 / 10003', async () => {
    const row = await prisma.client.assessment.findFirst({
      where: { mentorId: mentorBId, period: '2026-1' },
    });
    if (row === null) {
      throw new Error('B 院考核不见了');
    }

    const response = await api('asm-college')
      .get(`/assessments/${row.id.toString()}`)
      .expect(403);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  it('判据 19：不存在的考核 → 404 / 35001', async () => {
    const response = await api('asm-sc').get('/assessments/999999').expect(404);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.ASSESSMENT_NOT_FOUND,
    );
  });

  // ── 申诉（Task 42）────────────────────────────────────────────────

  it('判据 20：导师对已生效的考核申诉 → 201，status = 0', async () => {
    const row = await prisma.client.assessment.findFirst({
      where: { mentorId: mentorAId, period: '2026-1' },
    });
    if (row === null) {
      throw new Error('考核不见了');
    }
    expect(row.status).toBe(2);

    const response = await api('asm-mentor-a')
      .post(`/assessments/${row.id.toString()}/appeals`)
      .send({ reason: '初评材料遗漏了省级奖项，请复核。' })
      .expect(201);

    const data = (response.body as ResponseEnvelope<AppealResponseDto>).data;
    expect(data).toMatchObject({
      assessmentId: row.id.toString(),
      reason: '初评材料遗漏了省级奖项，请复核。',
      status: 0,
      reply: null,
      handledAt: null,
    });
  });

  it('判据 21：已有待处理申诉再提交 → 409 / 35005', async () => {
    const row = await prisma.client.assessment.findFirst({
      where: { mentorId: mentorAId, period: '2026-1' },
    });
    if (row === null) {
      throw new Error('考核不见了');
    }

    const response = await api('asm-mentor-a')
      .post(`/assessments/${row.id.toString()}/appeals`)
      .send({ reason: '再申诉一次' })
      .expect(409);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.ASSESSMENT_APPEAL_PENDING,
    );
  });

  it('判据 22：考核未生效（status = 1）时申诉 → 409 / 35006', async () => {
    const row = await prisma.client.assessment.findFirst({
      where: { mentorId: mentorBId, period: '2026-1' },
    });
    if (row === null) {
      throw new Error('B 院考核不见了');
    }
    expect(row.status).toBe(1);

    const response = await api('asm-mentor-b')
      .post(`/assessments/${row.id.toString()}/appeals`)
      .send({ reason: '还没终评就申诉' })
      .expect(409);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.ASSESSMENT_APPEAL_NOT_ALLOWED,
    );
  });

  it('判据 23：对别人的考核申诉 → 403 / 10003', async () => {
    const row = await prisma.client.assessment.findFirst({
      where: { mentorId: mentorAId, period: '2026-1' },
    });
    if (row === null) {
      throw new Error('考核不见了');
    }

    const response = await api('asm-mentor-b')
      .post(`/assessments/${row.id.toString()}/appeals`)
      .send({ reason: '这不是我的考核' })
      .expect(403);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  it('判据 24：受理申诉 → 200，考核**仍是** 2（R56：受理不改结果）', async () => {
    const row = await prisma.client.assessment.findFirst({
      where: { mentorId: mentorAId, period: '2026-1' },
    });
    if (row === null) {
      throw new Error('考核不见了');
    }
    const appeal = await prisma.client.assessmentAppeal.findFirst({
      where: { assessmentId: row.id, status: 0 },
    });
    if (appeal === null) {
      throw new Error('判据 20 的申诉不见了');
    }

    const response = await api('asm-sc')
      .post(
        `/assessments/${row.id.toString()}/appeals/${appeal.id.toString()}/handle`,
      )
      .send({ decision: 'accept', reply: '已收到，将在本月底前复核。' })
      .expect(200);

    const data = (response.body as ResponseEnvelope<AppealResponseDto>).data;
    expect(data.status).toBe(1);
    expect(data.reply).toBe('已收到，将在本月底前复核。');
    expect(data.handledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // R56 的可伪性：若受理顺手改了考核状态，这里会红
    const after = await prisma.client.assessment.findFirst({
      where: { id: row.id },
    });
    expect(after?.status).toBe(2);
    expect(after?.finalGrade).toBe(3);
  });

  it('判据 25：处理已终态的申诉 → 409 / 35002', async () => {
    const row = await prisma.client.assessment.findFirst({
      where: { mentorId: mentorAId, period: '2026-1' },
    });
    if (row === null) {
      throw new Error('考核不见了');
    }
    const appeal = await prisma.client.assessmentAppeal.findFirst({
      where: { assessmentId: row.id },
    });
    if (appeal === null) {
      throw new Error('申诉不见了');
    }

    const response = await api('asm-sc')
      .post(
        `/assessments/${row.id.toString()}/appeals/${appeal.id.toString()}/handle`,
      )
      .send({ decision: 'reject', reply: '再驳回一次' })
      .expect(409);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.ASSESSMENT_TRANSITION_INVALID,
    );
  });

  it('判据 26：申诉列表——导师本人可看，跨院管理员 403', async () => {
    const row = await prisma.client.assessment.findFirst({
      where: { mentorId: mentorAId, period: '2026-1' },
    });
    if (row === null) {
      throw new Error('考核不见了');
    }

    const mine = await api('asm-mentor-a')
      .get(`/assessments/${row.id.toString()}/appeals`)
      .expect(200);
    expect(
      (mine.body as ResponseEnvelope<AppealListResponseDto>).data.total,
    ).toBe(1);

    const crossDept = await api('asm-college-b')
      .get(`/assessments/${row.id.toString()}/appeals`)
      .expect(403);
    expect((crossDept.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  // ── 验收：一条链走到底（Task 44）────────────────────────────────

  it('判据 27：评价 → 4→6 → 成果 → 开考核（实时指标）→ 初评冻结 → 终评 → 申诉受理', async () => {
    // ① 造一条 `4 STUDENT_CONFIRMED` 的预约
    const appointment = await prisma.client.appointment.create({
      data: {
        studentPersonId: personOf('asm-student'),
        mentorProfileId: mentorCId,
        type: 1,
        status: 4,
        requestedTime: new Date('2026-03-01T02:00:00.000Z'),
        topic: '验收链路',
        questions: '这条预约只用于 P3 的端到端验收',
        mode: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });

    // ② 学生评价 → 预约同事务推进到 6
    const review = await api('asm-student')
      .post(`/appointments/${appointment.id.toString()}/review`)
      .send({ attitude: 5, expertise: 5, effect: 5, comment: '非常满意' })
      .expect(201);
    expect(
      (review.body as ResponseEnvelope<{ overallScore: string }>).data
        .overallScore,
    ).toBe('5.00');
    const afterReview = await prisma.client.appointment.findFirst({
      where: { id: appointment.id },
    });
    expect(afterReview?.status).toBe(6);

    // ③ 导师登记一条成果（落在当前学期内）
    const period = currentPeriod();
    const periodYear = period.slice(0, 4);
    const awardedAt = period.endsWith('-1')
      ? `${periodYear}-05-01`
      : `${periodYear}-11-01`;
    await api('asm-mentor-c')
      .post(`/mentors/${mentorCId.toString()}/achievements`)
      .send({
        type: 1,
        title: '验收用省级奖项',
        level: 2,
        awardedAt,
      })
      .expect(201);

    // ④ 学院开当前学期的考核 → 实时指标已含这条评价与成果
    const created = await api('asm-college')
      .post('/assessments')
      .send({ mentorId: mentorCId.toString(), period })
      .expect(201);
    const createdData = (
      created.body as ResponseEnvelope<AssessmentResponseDto>
    ).data;
    expect(createdData.status).toBe(0);
    expect(createdData.metrics.reviewCount).toBe(1);
    expect(createdData.metrics.reviewAvg).toBe('5.00');
    expect(createdData.metrics.achievementCount).toBe(1);
    // 评价 100×0.4 + 工作量 0×0.4 + 成果 20×0.2 = 44
    expect(createdData.metrics.compositeScore).toBe('44.00');

    // ⑤ 学院提交初评 → 冻结
    const submitted = await api('asm-college')
      .post(`/assessments/${createdData.id}/college-review`)
      .send({ grade: 1, comment: '验收链路：初评优秀。' })
      .expect(200);
    const submittedData = (
      submitted.body as ResponseEnvelope<AssessmentResponseDto>
    ).data;
    expect(submittedData.status).toBe(1);
    expect(submittedData.metrics.reviewCount).toBe(1);

    // ⑥ 冻结后补一条评价：详情数字不变
    const appointment2 = await prisma.client.appointment.create({
      data: {
        studentPersonId: personOf('asm-student'),
        mentorProfileId: mentorCId,
        type: 1,
        status: 6,
        requestedTime: new Date('2026-06-01T02:00:00.000Z'),
        topic: '冻结后补的评价',
        questions: '这条预约只用于证明冻结值不会变',
        mode: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    await prisma.client.studentReview.create({
      data: {
        appointmentId: appointment2.id,
        attitude: 1,
        expertise: 1,
        effect: 1,
        overallScore: '1.00',
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    const detail = await api('asm-college')
      .get(`/assessments/${createdData.id}`)
      .expect(200);
    const detailData = (detail.body as ResponseEnvelope<AssessmentResponseDto>)
      .data;
    expect(detailData.metrics.reviewCount).toBe(1);
    expect(detailData.metrics.reviewAvg).toBe('5.00');

    // ⑦ 双创学院终评通过
    const final = await api('asm-sc')
      .post(`/assessments/${createdData.id}/final-review`)
      .send({ decision: 'approve', grade: 1, comment: '终评：优秀。' })
      .expect(200);
    expect(
      (final.body as ResponseEnvelope<AssessmentResponseDto>).data.status,
    ).toBe(2);

    // ⑧ 导师申诉 → 待处理
    const appeal = await api('asm-mentor-c')
      .post(`/assessments/${createdData.id}/appeals`)
      .send({ reason: '希望补充下半年的成果。' })
      .expect(201);
    const appealData = (appeal.body as ResponseEnvelope<AppealResponseDto>)
      .data;
    expect(appealData.status).toBe(0);

    // ⑨ 双创学院受理 → 申诉终态，考核仍是 2
    const handled = await api('asm-sc')
      .post(`/assessments/${createdData.id}/appeals/${appealData.id}/handle`)
      .send({ decision: 'accept', reply: '已受理，下月复核。' })
      .expect(200);
    expect(
      (handled.body as ResponseEnvelope<AppealResponseDto>).data.status,
    ).toBe(1);

    const finalRow = await prisma.client.assessment.findFirst({
      where: { id: BigInt(createdData.id) },
    });
    expect(finalRow?.status).toBe(2);
    expect(finalRow?.finalGrade).toBe(1);
  });
});

/** 清考核与它上游的表（实体表走 includingDeleted，同步层走 syncWrite） */
async function clearAssessmentTables(prisma: PrismaService): Promise<void> {
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
