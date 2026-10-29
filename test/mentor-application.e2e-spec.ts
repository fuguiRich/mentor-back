import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type {
  MentorApplication,
  MentorProfile,
  SyncPerson,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { buildDocument, configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { runWithSyncWrite } from '../src/infra/prisma/sync-write-scope';
import { ErrorCode } from '../src/common/constants/error-code';
import type { FieldErrorDto } from '../src/common/dto/field-error.dto';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import type { PermissionResponseDto } from '../src/modules/permission/dto/permission-response.dto';
import type { RoleResponseDto } from '../src/modules/role/dto/role-response.dto';
import type { MentorApplicationResponseDto } from '../src/modules/mentor-application/dto/mentor-application-response.dto';
import {
  authedAgent,
  clearBusinessTables,
  clearRedisKeys,
  loginAs,
  seedSuperAdmin,
  seedUser,
  type E2eApi,
  type SeededUser,
} from './e2e-helpers';

/**
 * 入驻申请提交 (e2e) —— brief §5 的 13 条判据（判据 13 = docs:gen 的
 * 37 路径 / 52 操作，由门槛命令核，不在这里钉总数：总数会随 Task 14+ 长）。
 * 这里补一条**路由面**判据：/mentor-applications 上恰好 get + post 两条
 * （get 是 Task 14 的列表），多一条就是把 §1 之外的路由开出来了（红线 7）。
 *
 * 用例的执行顺序就是编号顺序（共享库态、maxWorkers:1 串行）：
 * 判据 10 排在 3/4/5 之后（先提交才有快照可钉），6 排在 10 之后
 * （10 要先模拟退回再改档案，6 正好接「退回后重交」）。
 * 并发双发（R70 返工新增）插在判据 12 之后：mentor-b 留下的正是起手式
 * （档案 status=0、零申请行），判据 7/8/9 用 mentor-c 不受影响。
 * 状态流转只能直改库模拟（写口在 Task 14/18），照 mentor.e2e-spec.ts 的 setStatus。
 */

const SYNCED_AT = new Date('2026-10-27T00:00:00.000Z');

const MENTOR_ONLY_MESSAGE =
  '只有导师（internalMentor / externalMentor）有专业档案';
const NOT_SUBMITTABLE_MESSAGE = '导师档案当前状态不允许提交入驻申请';
const ALREADY_ONBOARDED_MESSAGE = '导师已入驻，不能重复提交入驻申请';

describe('入驻申请提交 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let admin: SeededUser;
  let adminApi: E2eApi;

  /** 四个真实身份：校内导师 A / 校内导师 B / 校外导师 C / 学生 */
  const agents = new Map<string, E2eApi>();
  const people = new Map<string, SyncPerson>();

  /** 权限码 → 权限点 ID（本套件自建，seed 不播权限点） */
  const permissionIds = new Map<string, string>();

  /** 判据 3 捕获的「提交当时的档案」，判据 5 / 10 拿它逐字段比对 */
  let profileBeforeSubmit: MentorProfile;

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
    await clearMentorAndSyncTables(prisma);
    await clearRedisKeys(redis);

    admin = await seedSuperAdmin(prisma);
    const adminTokens = await loginAs(app, admin.username, admin.password);
    adminApi = authedAgent(app, adminTokens.accessToken);

    const root = await prisma.client.sysDept.findFirst({
      where: { name: '总公司' },
    });
    if (root === null) {
      throw new Error('seedSuperAdmin 未种出「总公司」部门');
    }

    // 同步层的行只有同步任务能写（SYNC_WRITE_FORBIDDEN）：测试造数走 runWithSyncWrite
    const org = await runWithSyncWrite(() =>
      prisma.client.syncOrgUnit.create({
        data: {
          code: 'ORG-APP',
          name: '创新创业学院',
          syncedAt: SYNCED_AT,
          createdBy: 0n,
          updatedBy: 0n,
        },
      }),
    );

    const identities: Array<[string, string]> = [
      ['mentor-a', 'internalMentor'],
      ['mentor-b', 'internalMentor'],
      ['mentor-c', 'externalMentor'],
      ['student-a', 'student'],
    ];
    for (const [login, personType] of identities) {
      const person = await runWithSyncWrite(() =>
        prisma.client.syncPerson.create({
          data: {
            login,
            realName: login,
            personType,
            orgUnitId: org.id,
            syncedAt: SYNCED_AT,
            createdBy: 0n,
            updatedBy: 0n,
          },
        }),
      );
      people.set(login, person);

      // username = login（自然键，schema 注释钉的；没有外键）
      const user = await seedUser(prisma, { username: login, deptId: root.id });
      // 学生也要提交权限：判据 2 要的是**身份门**的 403，不是权限门的
      const codes =
        personType === 'student'
          ? ['mentor-application:submit']
          : [
              'mentor-application:submit',
              'mentor:profile',
              'mentor:profile-update',
            ];
      await linkPermissions(login, user, codes);
    }

    for (const [login] of identities) {
      const user = await prisma.client.sysUser.findFirst({
        where: { username: login },
      });
      if (user === null) {
        throw new Error(`未种出用户 ${login}`);
      }
      const tokens = await loginAs(app, login, 'Passw0rd!');
      agents.set(login, authedAgent(app, tokens.accessToken));
    }
  });

  afterAll(async () => {
    try {
      if (prisma !== undefined) {
        await clearMentorAndSyncTables(prisma);
        await clearBusinessTables(prisma);
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

  /** 权限点 → 角色 → 用户（test/mentor.e2e-spec.ts 的套路） */
  async function linkPermissions(
    login: string,
    user: SeededUser,
    codes: string[],
  ): Promise<void> {
    const permIds: string[] = [];
    for (const code of codes) {
      permIds.push(await ensurePermissionId(code));
    }
    const roleBody = await adminApi
      .post('/roles')
      .send({
        name: `入驻申请角色 ${login}`,
        code: `ma_${login.replace(/-/g, '_')}`,
      })
      .expect(201);
    const role = (roleBody.body as ResponseEnvelope<RoleResponseDto>).data;
    await adminApi
      .put(`/roles/${role.id}/permissions`)
      .send({ permissionIds: permIds })
      .expect(200);
    await prisma.client.sysUserRole.create({
      data: {
        userId: user.userId,
        roleId: BigInt(role.id),
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
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

  function api(login: string): E2eApi {
    const agent = agents.get(login);
    if (agent === undefined) {
      throw new Error(`没有 ${login} 的登录态`);
    }
    return agent;
  }

  function personId(login: string): bigint {
    const person = people.get(login);
    if (person === undefined) {
      throw new Error(`没有 ${login} 的 SyncPerson`);
    }
    return person.id;
  }

  async function readRow(login: string): Promise<MentorProfile | null> {
    return prisma.client.mentorProfile.findFirst({
      where: { personId: personId(login) },
    });
  }

  /** 直接改库置 status（审核流的写口在 Task 14 / 18，测试造态只能这么造） */
  async function setStatus(login: string, status: number): Promise<void> {
    const row = await readRow(login);
    if (row === null) {
      throw new Error(`${login} 还没有档案行`);
    }
    await prisma.client.mentorProfile.update({
      where: { id: row.id },
      data: { status },
    });
  }

  /** 某个导师的申请行（Prisma 直查——比断言映射层更硬，brief §0.1） */
  async function applicationRows(login: string): Promise<MentorApplication[]> {
    return prisma.client.mentorApplication.findMany({
      where: { applicantId: personId(login) },
      orderBy: { id: 'asc' },
    });
  }

  /** 快照应有形状 = 档案行可填报字段 + 推导的 mentorType（brief §3） */
  function expectedDraft(
    row: MentorProfile,
    mentorType: 'internal' | 'external',
  ): Record<string, unknown> {
    return {
      mentorType,
      researchFields: row.researchFields,
      summary: row.summary,
      achievements: row.researchAchievements,
      guidanceExperience: row.guidanceExperience,
      affiliateOrg: row.affiliateOrg,
      socialRoles: row.socialRoles,
    };
  }

  function fullDraft(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      researchFields: ['创新创业', '人工智能'],
      summary: '个人简介一版',
      achievements: '研究成果一版',
      guidanceExperience: '指导经验一版',
      affiliateOrg: '合作单位一版',
      socialRoles: '社会任职一版',
      ...overrides,
    };
  }

  it('判据 1：未建档就提交 → 404 / 31102，无申请行落库', async () => {
    const response = await api('mentor-a')
      .post('/mentor-applications')
      .send({})
      .expect(404);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.MENTOR_PROFILE_NOT_FOUND);
    expect(body.message).toBe('导师专业档案不存在');
    expect(body.data).toBeNull();

    expect(await applicationRows('mentor-a')).toHaveLength(0);
  });

  it('判据 2：personType=student 提交 → 403 / 10003（不是 404），无申请行落库', async () => {
    const response = await api('student-a')
      .post('/mentor-applications')
      .send({})
      .expect(403);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.FORBIDDEN);
    expect(body.message).toBe(MENTOR_ONLY_MESSAGE);

    expect(await applicationRows('student-a')).toHaveLength(0);
    expect(await readRow('student-a')).toBeNull();
  });

  it('判据 3：status=0 DRAFT 提交 → 201；行落 type=1、status=2、submittedAt 非空、collegeReview/scReview 为 null', async () => {
    await api('mentor-a')
      .put('/mentor/profile')
      .send(fullDraft({ summary: '简介一版' }))
      .expect(200);
    profileBeforeSubmit = (await readRow('mentor-a')) as MentorProfile;
    expect(profileBeforeSubmit.status).toBe(0);

    const response = await api('mentor-a')
      .post('/mentor-applications')
      .send({})
      .expect(201);
    const data = (
      response.body as ResponseEnvelope<MentorApplicationResponseDto>
    ).data;
    expect(typeof data.id).toBe('string');
    expect(typeof data.applicantId).toBe('string');
    expect(data.type).toBe(1);
    expect(data.status).toBe(2);
    expect(data.collegeReview).toBeNull();
    expect(data.scReview).toBeNull();
    expect(data.submittedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );

    const rows = await applicationRows('mentor-a');
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe(1);
    expect(rows[0].status).toBe(2);
    expect(rows[0].submittedAt).not.toBeNull();
    expect(rows[0].collegeReview).toBeNull();
    expect(rows[0].scReview).toBeNull();
    expect(rows[0].applicantId).toBe(personId('mentor-a'));
    expect(rows[0].profileId).toBe(profileBeforeSubmit.id);
  });

  it('判据 4：档案侧 MentorProfile.status 0 → 1 PENDING（R52，与申请行同事务）', async () => {
    expect(profileBeforeSubmit.status).toBe(0);
    const after = (await readRow('mentor-a')) as MentorProfile;
    expect(after.status).toBe(1);
  });

  it('判据 5：snapshot 与提交当时的档案逐字段一致（含 mentorType 推导值），Prisma 直查', async () => {
    const rows = await applicationRows('mentor-a');
    expect(rows).toHaveLength(1);
    expect(rows[0].snapshot).toEqual(
      expectedDraft(profileBeforeSubmit, 'internal'),
    );
  });

  it('判据 10：快照不可变——提交后 PUT 改 summary，申请行 snapshot 逐字不变、档案行已变', async () => {
    const rows = await applicationRows('mentor-a');
    const snapshotAtSubmit = rows[0].snapshot;

    // 模拟 Task 14 退回（status=1 时 R55 会拒 PUT，只能先置回 3）
    await setStatus('mentor-a', 3);
    await api('mentor-a')
      .put('/mentor/profile')
      .send(fullDraft({ summary: '快照后改的简介' }))
      .expect(200);

    const afterRows = await applicationRows('mentor-a');
    expect(afterRows[0].snapshot).toEqual(snapshotAtSubmit);
    expect(afterRows[0].snapshot).toEqual(
      expectedDraft(profileBeforeSubmit, 'internal'),
    );

    const profileNow = (await readRow('mentor-a')) as MentorProfile;
    expect(profileNow.summary).toBe('快照后改的简介'); // 档案行已变
    expect(profileNow.status).toBe(3);
  });

  it('判据 6：status=3 REJECTED 重新提交 → 201，档案 → 1 PENDING（退回后能重交）', async () => {
    const response = await api('mentor-a')
      .post('/mentor-applications')
      .send({})
      .expect(201);
    const data = (
      response.body as ResponseEnvelope<MentorApplicationResponseDto>
    ).data;
    expect(data.status).toBe(2);

    const after = (await readRow('mentor-a')) as MentorProfile;
    expect(after.status).toBe(1);

    const rows = await applicationRows('mentor-a');
    expect(rows).toHaveLength(2);
    // 新行的快照是改后那一版；老行仍然逐字不变
    expect(rows[1].snapshot).toMatchObject({ summary: '快照后改的简介' });
    expect(rows[0].snapshot).toEqual(
      expectedDraft(profileBeforeSubmit, 'internal'),
    );
  });

  it('判据 12：越权写不串行——导师 C 提交后，B 的档案行逐字不动、B 无申请行；C 的行 applicantId/profileId 都是 C 自己的', async () => {
    await api('mentor-b')
      .put('/mentor/profile')
      .send(fullDraft({ summary: 'B 的简介' }))
      .expect(200);
    const beforeB = (await readRow('mentor-b')) as MentorProfile;

    await api('mentor-c')
      .put('/mentor/profile')
      .send(
        fullDraft({ affiliateOrg: '某某研究院', socialRoles: '某某学会理事' }),
      )
      .expect(200);
    await api('mentor-c').post('/mentor-applications').send({}).expect(201);

    expect(await readRow('mentor-b')).toEqual(beforeB);
    expect(await applicationRows('mentor-b')).toHaveLength(0);

    const rowsC = await applicationRows('mentor-c');
    expect(rowsC).toHaveLength(1);
    expect(rowsC[0].applicantId).toBe(personId('mentor-c'));
    const rowC = (await readRow('mentor-c')) as MentorProfile;
    expect(rowsC[0].profileId).toBe(rowC.id);
  });

  it('并发双发（R70）：同时两次 POST → 恰好一个 201、一个 409/31103，库里只有一条在审件', async () => {
    // 起手式（判据 12 留下的）：mentor-b 档案 status=0、零申请行
    expect((await readRow('mentor-b'))?.status).toBe(0);
    expect(await applicationRows('mentor-b')).toHaveLength(0);

    // 真并发：两条请求同时 dispatch（Promise.all 一起发）——不预先攒成
    // 串行 Promise 链（supertest 7 没有在途请求会关掉自动起的 server）
    const [r1, r2] = await Promise.all([
      api('mentor-b').post('/mentor-applications').send({}),
      api('mentor-b').post('/mentor-applications').send({}),
    ]);

    // 资格门是事务内的条件更新：恰好一发命中 {0,3}→1，输家拿 409/31103
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    const winner = (r1.status === 201 ? r1 : r2)
      .body as ResponseEnvelope<MentorApplicationResponseDto>;
    const loser = (r1.status === 201 ? r2 : r1).body as ResponseEnvelope<null>;
    expect(winner.data.status).toBe(2);
    expect(loser.code).toBe(ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE);
    expect(loser.message).toBe(NOT_SUBMITTABLE_MESSAGE);
    expect(loser.data).toBeNull();

    // 库侧终态：恰好一条 type=1 / status=2 在审件，档案恰为 1 PENDING
    const rows = await applicationRows('mentor-b');
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe(1);
    expect(rows[0].status).toBe(2);
    expect(rows[0].applicantId).toBe(personId('mentor-b'));
    const after = (await readRow('mentor-b')) as MentorProfile;
    expect(after.status).toBe(1);
  });

  it('判据 7：status=2 APPROVED 提交 → 409 / 31101「导师已入驻，不能重复提交入驻申请」，无申请行落库', async () => {
    const before = (await applicationRows('mentor-c')).length;
    await setStatus('mentor-c', 2);

    const response = await api('mentor-c')
      .post('/mentor-applications')
      .send({})
      .expect(409);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.MENTOR_ALREADY_ONBOARDED);
    expect(body.message).toBe(ALREADY_ONBOARDED_MESSAGE);
    expect(body.data).toBeNull();

    expect((await applicationRows('mentor-c')).length).toBe(before);
  });

  it('判据 8：status=1 PENDING 提交 → 409 / 31103「导师档案当前状态不允许提交入驻申请」，无申请行落库', async () => {
    const before = (await applicationRows('mentor-c')).length;
    await setStatus('mentor-c', 1);

    const response = await api('mentor-c')
      .post('/mentor-applications')
      .send({})
      .expect(409);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE);
    expect(body.message).toBe(NOT_SUBMITTABLE_MESSAGE);
    expect(body.data).toBeNull();

    expect((await applicationRows('mentor-c')).length).toBe(before);
  });

  it('判据 9：status=4 FROZEN / 5 REMOVED 提交 → 各 409 / 31103，无申请行落库', async () => {
    const before = (await applicationRows('mentor-c')).length;

    for (const status of [4, 5]) {
      await setStatus('mentor-c', status);
      const response = await api('mentor-c')
        .post('/mentor-applications')
        .send({})
        .expect(409);
      const body = response.body as ResponseEnvelope<null>;
      expect(body.code).toBe(ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE);
      expect(body.message).toBe(NOT_SUBMITTABLE_MESSAGE);
      expect(body.data).toBeNull();
    }

    expect((await applicationRows('mentor-c')).length).toBe(before);
  });

  it('判据 11：请求体塞 type / status / snapshot / personId 任一 → 400 / 10001，无申请行落库', async () => {
    const before = (await applicationRows('mentor-a')).length;

    // 逐条发：supertest 7 会在「没有在途请求」时关掉自动起的 server，
    // 预先攒成 Promise 链会让后面的 dispatch 拿到 address()=null
    for (const field of ['type', 'status', 'snapshot', 'personId']) {
      const response = await api('mentor-a')
        .post('/mentor-applications')
        .send({ [field]: '1' })
        .expect(400);
      const body = response.body as ResponseEnvelope<{
        fields: FieldErrorDto[];
      }>;
      expect(body.code).toBe(ErrorCode.PARAM_INVALID);
      expect(body.data.fields.some((f) => f.field === field)).toBe(true);
    }

    expect((await applicationRows('mentor-a')).length).toBe(before);
  });

  it('路由面：/mentor-applications 上恰好 get + post 两条，没有 §1 之外的路由（红线 7）', () => {
    const document = buildDocument(app);
    const item = document.paths['/mentor-applications'] as
      Record<string, unknown> | undefined;
    expect(item).toBeDefined();
    // Task 14 加了 GET（列表）——提交面仍是唯一一条 post
    expect(Object.keys(item as Record<string, unknown>).sort()).toEqual([
      'get',
      'post',
    ]);
  });
});

/**
 * 清残留。走裸 SQL（照 mentor.e2e-spec.ts 的同名函数）：清库是测试的运维动作，
 * 不是业务写入。顺序按外键拓扑序——mentor_application_material 先于
 * mentor_application，再 mentor_profile，再 sync_person / sync_org_unit。
 */
async function clearMentorAndSyncTables(prisma: PrismaService): Promise<void> {
  for (const table of [
    'achievement',
    'assessment_appeal',
    'assessment',
    'student_review',
    'guidance_material',
    'guidance_record',
    'appointment_material',
    'appointment',
    'mentor_time_slot',
    'mentor_application_material',
    'mentor_application',
    'mentor_profile',
    'sync_person',
    'sync_org_unit',
  ]) {
    await prisma.client.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
}
