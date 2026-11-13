import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { runWithSyncWrite } from '../src/infra/prisma/sync-write-scope';
import { AppointmentService } from '../src/modules/appointment/appointment.service';
import { ErrorCode } from '../src/common/constants/error-code';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import type {
  ReviewListResponseDto,
  ReviewResponseDto,
} from '../src/modules/review/dto/review-response.dto';
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
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const REVIEW_TTL_CONFIG_CODE = 'appointment.review_ttl_days';

/** 状态值（与 `APPOINTMENT_STATUS` 一致，这里写成字面量便于读） */
const STATUS_RECORD_SUBMITTED = 3;
const STATUS_STUDENT_CONFIRMED = 4;
const STATUS_COMPLETED = 6;

/**
 * 学生评价接口（P3 Task 34）。
 *
 * 覆盖 brief 的 12 条判据里能经 HTTP 观察的那部分；超期扫描的三条走
 * `AppointmentService.expireOverdue()` 直接调（它是公开方法，定时器只是调用者）。
 *
 * 顺序即依赖：先造三条状态不同的预约，再按「守卫 → 成功 → 幂等 → 读 → 汇总 → 扫描」走。
 * `maxWorkers: 1` 串行，不存在跨套件干扰。
 */
describe('学生评价接口（P3 Task 34）(e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let appointments: AppointmentService;

  const agents = new Map<string, E2eApi>();
  const permissionIds = new Map<string, bigint>();
  const people = new Map<string, bigint>();
  let mentorProfileId: bigint;

  /** 可评价的预约（student → mentor，status 4） */
  let reviewableId: bigint;
  /** 状态不对的预约（status 3） */
  let wrongStatusId: bigint;
  /** 别人的预约（other-student → mentor，status 4） */
  let foreignId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    appointments = app.get(AppointmentService);

    await clearReviewTables(prisma);
    await clearBusinessTables(prisma);
    await clearModuleTables(prisma);

    await seedSuperAdmin(prisma);
    const rootDept = await prisma.client.sysDept.findFirst({
      where: { name: '总公司' },
    });
    if (rootDept === null) {
      throw new Error('seedSuperAdmin 未种出「总公司」部门');
    }

    const org = await runWithSyncWrite(() =>
      prisma.client.syncOrgUnit.create({
        data: {
          code: 'ORG-REVIEW-API',
          name: '评价接口学院',
          kind: 'college',
          deptId: rootDept.id,
          syncedAt: SYNCED_AT,
          createdBy: 0n,
          updatedBy: 0n,
        },
      }),
    );

    for (const [login, realName, personType] of [
      ['rev-student', '评价学生甲', 'student'],
      ['rev-other', '评价学生乙', 'student'],
      ['rev-mentor', '评价导师', 'internalMentor'],
      // 第二个导师人：`mentor_profile` 对 `person_id` 有唯一键（一人一份档案），
      // 「没有评价的导师」必须是另一个**人**，不能给 rev-mentor 再建一份档案
      ['rev-mentor2', '评价导师乙', 'internalMentor'],
    ] as const) {
      const person = await runWithSyncWrite(() =>
        prisma.client.syncPerson.create({
          data: {
            login,
            realName,
            personType,
            orgUnitId: org.id,
            syncedAt: SYNCED_AT,
            createdBy: 0n,
            updatedBy: 0n,
          },
        }),
      );
      people.set(login, person.id);
    }

    const profile = await prisma.client.mentorProfile.create({
      data: {
        personId: personOf('rev-mentor'),
        researchFields: ['创新创业'],
        status: 2,
        professionalTitle: '教授',
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    mentorProfileId = profile.id;

    // 角色与权限：只建本套件需要的几个码
    const studentRole = await createRole('学生', 'student', 'self', [
      'review:create',
      'review:list',
    ]);
    const mentorRole = await createRole('导师', 'mentor', 'self', [
      'review:list',
    ]);
    const collegeRole = await createRole(
      '二级学院管理员',
      'college_admin',
      'deptAndChildren',
      ['review:list'],
    );

    const users: Array<[string, bigint]> = [
      ['rev-student', studentRole],
      ['rev-other', studentRole],
      ['rev-mentor', mentorRole],
      ['rev-college', collegeRole],
    ];
    for (const [username, roleId] of users) {
      const user = await seedUser(prisma, { username, deptId: rootDept.id });
      await prisma.client.sysUserRole.create({
        data: { userId: user.userId, roleId, createdBy: 0n, updatedBy: 0n },
      });
    }
    for (const [username] of users) {
      const tokens = await loginAs(app, username, 'Passw0rd!');
      agents.set(username, authedAgent(app, tokens.accessToken));
    }

    reviewableId = await createAppointment(
      'rev-student',
      STATUS_STUDENT_CONFIRMED,
    );
    wrongStatusId = await createAppointment(
      'rev-student',
      STATUS_RECORD_SUBMITTED,
    );
    foreignId = await createAppointment('rev-other', STATUS_STUDENT_CONFIRMED);
  });

  afterAll(async () => {
    try {
      if (prisma !== undefined) {
        await clearReviewTables(prisma);
        await clearBusinessTables(prisma);
        await clearModuleTables(prisma);
      }
    } finally {
      if (app !== undefined) {
        await app.close();
      }
    }
  });

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

  async function createAppointment(
    studentLogin: string,
    status: number,
    extra: { adjudicateComment?: string } = {},
  ): Promise<bigint> {
    const row = await prisma.client.appointment.create({
      data: {
        studentPersonId: personOf(studentLogin),
        mentorProfileId,
        type: 1,
        status,
        requestedTime: new Date(Date.now() + DAY_MS),
        topic: '评价用例的预约',
        questions: '这条预约只用于评价接口的判据',
        mode: 1,
        ...(extra.adjudicateComment === undefined
          ? {}
          : { adjudicateComment: extra.adjudicateComment }),
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    return row.id;
  }

  async function readStatus(id: bigint): Promise<number | undefined> {
    const row = await prisma.client.appointment.findFirst({ where: { id } });
    return row?.status;
  }

  function reviewBody(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { attitude: 5, expertise: 4, effect: 4, ...overrides };
  }

  // ── 一、守卫 ──────────────────────────────────────────────────────

  it('判据 1：非本人评价 → 403 / 32002（不是 404）', async () => {
    const response = await api('rev-other')
      .post(`/appointments/${reviewableId.toString()}/review`)
      .send(reviewBody())
      .expect(403);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.APPOINTMENT_FORBIDDEN,
    );
    // 预约没有被推进：被挡住的是整个请求，不是「评价失败但状态变了」
    expect(await readStatus(reviewableId)).toBe(STATUS_STUDENT_CONFIRMED);
  });

  it('判据 2：status = 3 时评价 → 409 / 34003', async () => {
    const response = await api('rev-student')
      .post(`/appointments/${wrongStatusId.toString()}/review`)
      .send(reviewBody())
      .expect(409);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.REVIEW_NOT_ALLOWED,
    );
    expect(await readStatus(wrongStatusId)).toBe(STATUS_RECORD_SUBMITTED);
  });

  it('判据 8a：body 里多传 overallScore → 400 / 10001（总分只能服务端算）', async () => {
    const response = await api('rev-student')
      .post(`/appointments/${reviewableId.toString()}/review`)
      .send(reviewBody({ overallScore: '5.00' }))
      .expect(400);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PARAM_INVALID,
    );
  });

  it('判据 8b：三个维度越界 → 400 / 10001，且点名字段', async () => {
    const response = await api('rev-student')
      .post(`/appointments/${reviewableId.toString()}/review`)
      .send(reviewBody({ effect: 6 }))
      .expect(400);

    const body = response.body as {
      code: number;
      data: { fields: Array<{ field: string }> };
    };
    expect(body.code).toBe(ErrorCode.PARAM_INVALID);
    expect(body.data.fields.map((field) => field.field)).toContain('effect');
  });

  // ── 二、成功路径 ──────────────────────────────────────────────────

  it('判据 3：评价成功 → 201、overallScore = "4.33"、预约同事务变 6', async () => {
    const response = await api('rev-student')
      .post(`/appointments/${reviewableId.toString()}/review`)
      .send(reviewBody({ comment: '讲解清晰，给的三条技术路线很有用。' }))
      .expect(201);

    const data = (response.body as ResponseEnvelope<ReviewResponseDto>).data;
    expect(data).toMatchObject({
      appointmentId: reviewableId.toString(),
      mentorProfileId: mentorProfileId.toString(),
      attitude: 5,
      expertise: 4,
      effect: 4,
      overallScore: '4.33',
      comment: '讲解清晰，给的三条技术路线很有用。',
    });
    expect(data.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(await readStatus(reviewableId)).toBe(STATUS_COMPLETED);
  });

  it('判据 5：重复评价 → 409 / 34002', async () => {
    const response = await api('rev-student')
      .post(`/appointments/${reviewableId.toString()}/review`)
      .send(reviewBody())
      .expect(409);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.REVIEW_ALREADY_EXISTS,
    );
  });

  it('判据 6：响应匿名——字段全集里没有任何学生身份', async () => {
    const response = await api('rev-student')
      .get(`/appointments/${reviewableId.toString()}/review`)
      .expect(200);

    const data = (response.body as ResponseEnvelope<ReviewResponseDto>).data;
    // 断言**全集**，不是抽查几个：抽查会漏掉「以后有人加了一个 studentName」
    expect(Object.keys(data).sort()).toEqual(
      [
        'appointmentId',
        'attitude',
        'comment',
        'createdAt',
        'effect',
        'expertise',
        'id',
        'mentorProfileId',
        'overallScore',
      ].sort(),
    );
  });

  it('判据 7：comment 省略 → 落 null，响应 null', async () => {
    const response = await api('rev-other')
      .post(`/appointments/${foreignId.toString()}/review`)
      .send({ attitude: 3, expertise: 3, effect: 3 })
      .expect(201);

    const data = (response.body as ResponseEnvelope<ReviewResponseDto>).data;
    expect(data.comment).toBeNull();
    expect(data.overallScore).toBe('3.00');

    const row = await prisma.client.studentReview.findFirst({
      where: { appointmentId: foreignId },
    });
    expect(row?.comment).toBeNull();
  });

  it('判据 8c：还没评价的预约读评价 → 404 / 34001', async () => {
    const response = await api('rev-student')
      .get(`/appointments/${wrongStatusId.toString()}/review`)
      .expect(404);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.REVIEW_NOT_FOUND,
    );
  });

  // ── 三、导师维度的汇总 ────────────────────────────────────────────

  it('判据 12：列表字段是 list 不是 items，summary 是全量口径', async () => {
    const response = await api('rev-college')
      .get(`/mentors/${mentorProfileId.toString()}/reviews`)
      .expect(200);

    const data = (response.body as ResponseEnvelope<ReviewListResponseDto>)
      .data;
    expect(Object.keys(data).sort()).toEqual(
      ['list', 'page', 'pageSize', 'summary', 'total'].sort(),
    );
    expect(data.total).toBe(2);
    expect(data.list).toHaveLength(2);
    expect(data.summary).toEqual({
      count: 2,
      // (4.33 + 3.00) / 2 = 3.665 → 3.67（2 位小数，四舍五入）
      avg: 3.67,
      attitudeAvg: 4,
      expertiseAvg: 3.5,
      effectAvg: 3.5,
    });
    // 分页取一半，summary 不跟着变小
    const paged = await api('rev-college')
      .get(`/mentors/${mentorProfileId.toString()}/reviews`)
      .query({ page: 1, pageSize: 1 })
      .expect(200);
    const pagedData = (paged.body as ResponseEnvelope<ReviewListResponseDto>)
      .data;
    expect(pagedData.list).toHaveLength(1);
    expect(pagedData.total).toBe(2);
    expect(pagedData.summary.count).toBe(2);
  });

  it('判据 9：没有评价的导师 → summary 四个均值是 null（不是 0）', async () => {
    const emptyProfile = await prisma.client.mentorProfile.create({
      data: {
        personId: personOf('rev-mentor2'),
        researchFields: ['另一方向'],
        status: 2,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });

    const response = await api('rev-college')
      .get(`/mentors/${emptyProfile.id.toString()}/reviews`)
      .expect(200);

    const data = (response.body as ResponseEnvelope<ReviewListResponseDto>)
      .data;
    expect(data.total).toBe(0);
    expect(data.summary).toEqual({
      count: 0,
      avg: null,
      attitudeAvg: null,
      expertiseAvg: null,
      effectAvg: null,
    });
  });

  it('判据 10：导师档案不存在 → 404 / 31102', async () => {
    const response = await api('rev-college')
      .get('/mentors/999999/reviews')
      .expect(404);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.MENTOR_PROFILE_NOT_FOUND,
    );
  });

  // ── 四、超期扫描：4 → 6 ───────────────────────────────────────────

  it('判据 11a：评价窗口默认 30 天——31 天前确认的预约被推进到 6', async () => {
    const id = await createAppointment('rev-student', STATUS_STUDENT_CONFIRMED);
    const row = await prisma.client.appointment.findFirst({ where: { id } });
    if (row === null) {
      throw new Error('预约没落库');
    }

    // 把时钟推到 updatedAt + 31 天：cutoff = updatedAt + 1 天 > updatedAt → 扫
    const result = await appointments.expireOverdue(
      new Date(row.updatedAt.getTime() + 31 * DAY_MS),
    );

    expect(result.completed).toBeGreaterThanOrEqual(1);
    expect(await readStatus(id)).toBe(STATUS_COMPLETED);
  });

  it('判据 11b：29 天前确认的预约**不**被推进（窗口还没到）', async () => {
    const id = await createAppointment('rev-student', STATUS_STUDENT_CONFIRMED);
    const row = await prisma.client.appointment.findFirst({ where: { id } });
    if (row === null) {
      throw new Error('预约没落库');
    }

    const result = await appointments.expireOverdue(
      new Date(row.updatedAt.getTime() + 29 * DAY_MS),
    );

    expect(result.completed).toBe(0);
    expect(await readStatus(id)).toBe(STATUS_STUDENT_CONFIRMED);
  });

  it('判据 11c：窗口配成负数 → 按 0 处理，cutoff 不落到未来', async () => {
    const id = await createAppointment('rev-student', STATUS_STUDENT_CONFIRMED);
    const row = await prisma.client.appointment.findFirst({ where: { id } });
    if (row === null) {
      throw new Error('预约没落库');
    }

    await setNumberConfig(REVIEW_TTL_CONFIG_CODE, -1);
    try {
      // now 取 updatedAt 前 1 小时：不 clamp 的话 cutoff = now + 1 天 = updatedAt + 23 小时，
      // 这条刚确认的预约会被误扫成 6（6 是终态，不可逆）
      const result = await appointments.expireOverdue(
        new Date(row.updatedAt.getTime() - HOUR_MS),
      );

      expect(result.completed).toBe(0);
      expect(await readStatus(id)).toBe(STATUS_STUDENT_CONFIRMED);
    } finally {
      await prisma.includingDeleted.sysConfig.deleteMany({
        where: { code: REVIEW_TTL_CONFIG_CODE },
      });
    }
  });

  // ── 五、异议复核完成后仍可评价（裁决 uphold → 6，随后补评价）─────────

  it('裁决完成（6 + adjudicateComment）→ 仍可评价，201，状态保持 6', async () => {
    const id = await createAppointment('rev-student', STATUS_COMPLETED, {
      adjudicateComment: '经核对，记录内容属实，维持原记录。',
    });

    const response = await api('rev-student')
      .post(`/appointments/${id.toString()}/review`)
      .send(reviewBody({ attitude: 4, expertise: 4, effect: 5 }))
      .expect(201);

    const data = (response.body as ResponseEnvelope<ReviewResponseDto>).data;
    expect(data).toMatchObject({
      appointmentId: id.toString(),
      overallScore: '4.33',
    });

    // 评价不改预约状态（它已经是终态 6），也不动裁决意见
    const row = await prisma.client.appointment.findFirst({ where: { id } });
    expect(row?.status).toBe(STATUS_COMPLETED);
    expect(row?.adjudicateComment).toBe('经核对，记录内容属实，维持原记录。');
  });

  it('裁决完成后重复评价 → 409 / 34002', async () => {
    const id = await createAppointment('rev-student', STATUS_COMPLETED, {
      adjudicateComment: '重复评价用例。',
    });
    await api('rev-student')
      .post(`/appointments/${id.toString()}/review`)
      .send(reviewBody())
      .expect(201);

    const response = await api('rev-student')
      .post(`/appointments/${id.toString()}/review`)
      .send(reviewBody())
      .expect(409);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.REVIEW_ALREADY_EXISTS,
    );
  });

  it('正常完成（6 但没有裁决意见）→ 409 / 34003（不放开普通已完成单）', async () => {
    const id = await createAppointment('rev-student', STATUS_COMPLETED);

    const response = await api('rev-student')
      .post(`/appointments/${id.toString()}/review`)
      .send(reviewBody())
      .expect(409);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.REVIEW_NOT_ALLOWED,
    );
    expect((response.body as ResponseEnvelope<null>).message).toBe(
      '当前状态不允许评价',
    );
  });

  it('裁决完成已超过评价窗口（31 天前）→ 409 / 34003，提示窗口已关闭', async () => {
    const id = await createAppointment('rev-student', STATUS_COMPLETED, {
      adjudicateComment: '窗口关闭用例。',
    });
    await pinUpdatedAt(id, new Date(Date.now() - 31 * DAY_MS));

    const response = await api('rev-student')
      .post(`/appointments/${id.toString()}/review`)
      .send(reviewBody())
      .expect(409);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.REVIEW_NOT_ALLOWED,
    );
    expect((response.body as ResponseEnvelope<null>).message).toBe(
      '评价窗口已关闭',
    );
  });

  it('裁决完成仍在窗口内（29 天前）→ 201', async () => {
    const id = await createAppointment('rev-student', STATUS_COMPLETED, {
      adjudicateComment: '窗口内用例。',
    });
    await pinUpdatedAt(id, new Date(Date.now() - 29 * DAY_MS));

    await api('rev-student')
      .post(`/appointments/${id.toString()}/review`)
      .send(reviewBody())
      .expect(201);
  });

  /**
   * 造「很久以前裁决完成」的预约：`updated_at` 走裸 SQL 钉值。
   * Prisma 的写路径会被审计扩展重写，只有裸 SQL 能设进指定时间（测试造数）。
   */
  async function pinUpdatedAt(id: bigint, at: Date): Promise<void> {
    await prisma.client.$executeRawUnsafe(
      'UPDATE appointment SET updated_at = ? WHERE id = ?',
      at,
      id,
    );
  }

  async function setNumberConfig(code: string, value: number): Promise<void> {
    await prisma.includingDeleted.sysConfig.deleteMany({ where: { code } });
    await prisma.client.sysConfig.create({
      data: {
        code,
        name: `测试用 ${code}`,
        value: String(value),
        valueType: 'number',
        status: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
  }
});

/** 清评价与它上游的表，按外键拓扑序（实体表走 includingDeleted，同步层走 syncWrite） */
async function clearReviewTables(prisma: PrismaService): Promise<void> {
  await prisma.includingDeleted.studentReview.deleteMany({});
  await prisma.includingDeleted.assessmentAppeal.deleteMany({});
  await prisma.includingDeleted.assessment.deleteMany({});
  await prisma.includingDeleted.guidanceMaterial.deleteMany({});
  await prisma.includingDeleted.guidanceRecord.deleteMany({});
  await prisma.includingDeleted.appointmentMaterial.deleteMany({});
  await prisma.includingDeleted.appointment.deleteMany({});
  await prisma.includingDeleted.mentorTimeSlot.deleteMany({});
  await prisma.includingDeleted.achievement.deleteMany({});
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
