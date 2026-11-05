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
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import type { PermissionResponseDto } from '../src/modules/permission/dto/permission-response.dto';
import type { RoleResponseDto } from '../src/modules/role/dto/role-response.dto';
import type { MentorApplicationResponseDto } from '../src/modules/mentor-application/dto/mentor-application-response.dto';
import type { ReviewRecord } from '../src/modules/mentor-application/dto/review.dto';
import {
  authedAgent,
  clearBusinessTables,
  clearModuleTables,
  clearRedisKeys,
  loginAs,
  seedSuperAdmin,
  seedUser,
  type E2eApi,
  type SeededUser,
} from './e2e-helpers';

/**
 * 信息修改申请 (e2e) —— brief §5 的 20 条判据（判据 20 = docs:gen 56 路径 /
 * 75 操作；总数在这里钉一份，另由门槛命令核）。
 *
 * 用例执行顺序就是编号顺序（共享库态、maxWorkers:1 串行）：
 * 判据 1/2 各自走完整审批链（1 验写回、2 验 status 全程），判据 3/4/5 在
 * chg-f 一具档案上直改库切 status 试 PUT 门，判据 6/7 在 chg-g 上试提交门，
 * 判据 10/11/12 是 R58 的一条链（在审 → 5 → 3 → 可再提），判据 15/16 复用
 * 判据 1 的留痕与生效后状态，判据 17/18 复用链上的行，判据 19 并发双发复用
 * chg-g（判据 7 后拨回 status=2，轮间 withdraw 清场）。
 *
 * 造态约定（照 mentor-application.e2e-spec.ts）：`MentorProfile.status=2` 与
 * 申请状态机的中间态都**直改库**造——测试造态不是业务写口；真实写口走 HTTP。
 */

const SYNCED_AT = new Date('2026-10-27T00:00:00.000Z');

const MENTOR_ONLY_MESSAGE =
  '只有导师（internalMentor / externalMentor）有专业档案';
const PROFILE_NOT_FOUND_MESSAGE = '导师专业档案不存在';
const IN_FLIGHT_MESSAGE = '已有在审的申请，不能重复提交';
const PUT_ON_APPROVED_MESSAGE = '导师专业档案已生效，改字段走信息修改申请';
const PUT_ON_PENDING_MESSAGE = '导师专业档案在审，撤回后再改';
const SUBMIT_ON_DRAFT_MESSAGE =
  '导师档案还是草稿，改草稿走 PUT /mentor/profile';
const SUBMIT_ON_PENDING_MESSAGE =
  '导师专业档案在审，入驻通过后再提信息修改申请';
const SUBMIT_NOT_ELIGIBLE_MESSAGE = '导师档案当前状态不允许提交信息修改申请';

const HTTP_METHODS = new Set([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
]);

/** 快照 / 留痕里 7 个可填报字段的形状（DTO 键名，R68） */
interface DraftFields {
  researchFields: string[];
  summary: string | null;
  achievements: string | null;
  guidanceExperience: string | null;
  affiliateOrg: string | null;
  socialRoles: string | null;
  professionalTitle: string | null;
}

describe('信息修改申请 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let admin: SeededUser;
  let adminApi: E2eApi;

  const agents = new Map<string, E2eApi>();
  const people = new Map<string, SyncPerson>();
  const permissionIds = new Map<string, string>();

  /** 判据 1 的申请行 / 档案行（判据 15/16 复用） */
  let chgAApp: MentorApplication;
  let chgAProfileId: bigint;
  /** 判据 1 提案的合并快照（判据 15 的新值对照） */
  let chgASnapshot: DraftFields & { mentorType: string };
  /** 判据 12 重提的行（判据 18 复用） */
  let chgDApp2: MentorApplication;

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
    await clearModuleTables(prisma);
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

    // 同步层的行只有同步任务能写（SYNC_WRITE_FORBIDDEN）：造数走 runWithSyncWrite
    const org = await runWithSyncWrite(() =>
      prisma.client.syncOrgUnit.create({
        data: {
          code: 'ORG-CHANGE',
          name: '信息修改组织',
          deptId: root.id,
          syncedAt: SYNCED_AT,
          createdBy: 0n,
          updatedBy: 0n,
        },
      }),
    );

    // 三个角色：导师权限一份；两个审核者各持各的权限码 + 数据范围（真实权限路径）
    const mentorRole = await createRoleWithCodes(
      '信息修改导师角色',
      'chg_mentor',
      'self',
      [
        'mentor-application:submit',
        'mentor-application:withdraw',
        'mentor:profile',
        'mentor:profile-update',
      ],
    );
    const collegeRole = await createRoleWithCodes(
      '信息修改二级学院管理员',
      'chg_college',
      'deptAndChildren',
      ['mentor-application:review-college', 'mentor-application:list'],
    );
    const scRole = await createRoleWithCodes(
      '信息修改双创管理员',
      'chg_sc',
      'all',
      ['mentor-application:review-sc', 'mentor-application:list'],
    );

    // 十个身份：八具档案（判据 1-7、10-18）、一个无档案导师（判据 8）、一个学生（判据 9）
    const identities: Array<[string, string, boolean]> = [
      ['chg-a', 'internalMentor', true],
      ['chg-a2', 'internalMentor', true],
      ['chg-f', 'externalMentor', true],
      ['chg-g', 'internalMentor', true],
      ['chg-none', 'internalMentor', false],
      ['chg-stu', 'student', true],
      ['chg-d', 'internalMentor', true],
      ['chg-b', 'externalMentor', true],
      ['chg-c', 'internalMentor', true],
      ['chg-e', 'internalMentor', true],
    ];
    for (const [login, personType, hasProfile] of identities) {
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
      const user = await seedUser(prisma, { username: login, deptId: root.id });
      await linkUserRole(user.userId, BigInt(mentorRole.id));
      await loginFor(login);

      // 档案先建好（PUT upsert），再直改库推到 2 APPROVED——「已入驻」是本任务的前置态
      if (hasProfile && personType !== 'student') {
        await api(login).put('/mentor/profile').send(fullDraft()).expect(200);
        await setStatus(login, 2);
      }
    }

    // 两个审核者（不需要 SyncPerson：审核走的是账号 + 权限码 + 数据范围）
    for (const [login, role] of [
      ['chg-college-admin', collegeRole],
      ['chg-sc-admin', scRole],
    ] as Array<[string, RoleResponseDto]>) {
      const user = await seedUser(prisma, {
        username: login,
        deptId: root.id,
      });
      await linkUserRole(user.userId, BigInt(role.id));
      await loginFor(login);
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

  async function linkUserRole(userId: bigint, roleId: bigint): Promise<void> {
    await prisma.client.sysUserRole.create({
      data: { userId, roleId, createdBy: 0n, updatedBy: 0n },
    });
  }

  async function loginFor(login: string): Promise<void> {
    const tokens = await loginAs(app, login, 'Passw0rd!');
    agents.set(login, authedAgent(app, tokens.accessToken));
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

  async function readProfile(login: string): Promise<MentorProfile | null> {
    return prisma.client.mentorProfile.findFirst({
      where: { personId: personId(login) },
    });
  }

  /** 直接改库置档案 status（审核流的写口在 Task 13/14，测试造态只能这么造） */
  async function setStatus(login: string, status: number): Promise<void> {
    const row = await readProfile(login);
    if (row === null) {
      throw new Error(`${login} 还没有档案行`);
    }
    await prisma.client.mentorProfile.update({
      where: { id: row.id },
      data: { status },
    });
  }

  async function applicationRows(login: string): Promise<MentorApplication[]> {
    return prisma.client.mentorApplication.findMany({
      where: { applicantId: personId(login) },
      orderBy: { id: 'asc' },
    });
  }

  async function readApp(id: bigint): Promise<MentorApplication> {
    const row = await prisma.client.mentorApplication.findFirst({
      where: { id },
    });
    if (row === null) {
      throw new Error(`没有 ${id.toString()} 这条申请`);
    }
    return row;
  }

  /** 7 个可填报字段（DTO 键名，R68 翻译后） */
  function draftFields(row: MentorProfile): DraftFields {
    return {
      // JSON 列在 Prisma 侧是 JsonValue；档案的形状是 string[]（DTO 同款）
      researchFields: row.researchFields as string[],
      summary: row.summary,
      achievements: row.researchAchievements,
      guidanceExperience: row.guidanceExperience,
      affiliateOrg: row.affiliateOrg,
      socialRoles: row.socialRoles,
      professionalTitle: row.professionalTitle,
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
      professionalTitle: '职称一版',
      ...overrides,
    };
  }

  /** 提交信息修改申请（R56 的新路由），返回落库行 */
  async function submitChange(
    login: string,
    body: Record<string, unknown>,
  ): Promise<MentorApplication> {
    const response = await api(login)
      .post('/mentor-applications/profile-change')
      .send(body)
      .expect(201);
    const data = (
      response.body as ResponseEnvelope<MentorApplicationResponseDto>
    ).data;
    expect(data.status).toBe(2);
    const rows = await applicationRows(login);
    return rows[rows.length - 1];
  }

  async function review(
    login: string,
    appId: bigint,
    hop: 'college-review' | 'sc-review',
    decision: 'approve' | 'reject',
    comment: string,
  ): Promise<void> {
    await api(login)
      .post(`/mentor-applications/${appId.toString()}/${hop}`)
      .send({ decision, comment })
      .expect(200);
  }

  it('判据 1：全链路——status=2 提 type=2 → 两级审通过 → 7 个字段逐字段等于 snapshot', async () => {
    const before = (await readProfile('chg-a')) as MentorProfile;
    chgAProfileId = before.id;
    const proposal = {
      researchFields: ['智能制造'],
      summary: '改后简介',
      achievements: null,
      // R28：职称 / 资质随提案改，生效后写回档案
      professionalTitle: '教授',
    };
    chgASnapshot = {
      mentorType: 'internal',
      researchFields: ['智能制造'],
      summary: '改后简介',
      achievements: null,
      // 省略 = 不动
      guidanceExperience: before.guidanceExperience,
      // R49：内校恒 null
      affiliateOrg: null,
      socialRoles: null,
      // R28：内校也填——提案给了就改
      professionalTitle: '教授',
    };

    // 三步 201/200/200
    chgAApp = await submitChange('chg-a', proposal);
    expect(chgAApp.type).toBe(2);
    await review(
      'chg-college-admin',
      chgAApp.id,
      'college-review',
      'approve',
      '提案合理，同意',
    );
    await review(
      'chg-sc-admin',
      chgAApp.id,
      'sc-review',
      'approve',
      '同意修改',
    );

    const row = await readApp(chgAApp.id);
    expect(row.status).toBe(6);
    // 库里字段逐字段等于 snapshot（R67 的合并快照，不是 DTO 原文）
    expect(row.snapshot).toEqual(chgASnapshot);
    const after = (await readProfile('chg-a')) as MentorProfile;
    expect(draftFields(after)).toEqual({
      researchFields: chgASnapshot.researchFields,
      summary: chgASnapshot.summary,
      achievements: chgASnapshot.achievements,
      guidanceExperience: chgASnapshot.guidanceExperience,
      affiliateOrg: chgASnapshot.affiliateOrg,
      socialRoles: chgASnapshot.socialRoles,
      professionalTitle: chgASnapshot.professionalTitle,
    });
  });

  it('判据 2：同上，MentorProfile.status 全程仍为 2（不被降级、不被改写）', async () => {
    // 独立走一条链，三个时点各读一次 status
    const app2 = await submitChange('chg-a2', { summary: '全程跟踪简介' });
    expect(((await readProfile('chg-a2')) as MentorProfile).status).toBe(2);

    await review(
      'chg-college-admin',
      app2.id,
      'college-review',
      'approve',
      '本院通过',
    );
    expect(((await readProfile('chg-a2')) as MentorProfile).status).toBe(2);

    await review('chg-sc-admin', app2.id, 'sc-review', 'approve', '双创通过');
    const final = (await readProfile('chg-a2')) as MentorProfile;
    expect(final.status).toBe(2);
    // 生效只写 7 个可填报字段（§0.5）：写回发生了，status 没动
    expect(final.summary).toBe('全程跟踪简介');
  });

  it('判据 3：R55——status=2 调 PUT → 409 / 31103，库里字段逐字不变', async () => {
    const before = (await readProfile('chg-f')) as MentorProfile;
    expect(before.status).toBe(2);
    const fieldsBefore = draftFields(before);

    const response = await api('chg-f')
      .put('/mentor/profile')
      .send(fullDraft({ summary: '已生效了还想改' }))
      .expect(409);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE);
    expect(body.message).toBe(PUT_ON_APPROVED_MESSAGE);

    const after = (await readProfile('chg-f')) as MentorProfile;
    expect(draftFields(after)).toEqual(fieldsBefore);
  });

  it('判据 4：R55——status=0 / 3 调 PUT → 200，照常 upsert', async () => {
    for (const status of [0, 3]) {
      await setStatus('chg-f', status);
      await api('chg-f')
        .put('/mentor/profile')
        .send(fullDraft({ summary: `草稿态 ${status} 改的` }))
        .expect(200);
      const row = (await readProfile('chg-f')) as MentorProfile;
      expect(row.summary).toBe(`草稿态 ${status} 改的`);
    }
  });

  it('判据 5：R55——status=1 调 PUT → 409 / 31103', async () => {
    await setStatus('chg-f', 1);
    const fieldsBefore = draftFields(
      (await readProfile('chg-f')) as MentorProfile,
    );

    const response = await api('chg-f')
      .put('/mentor/profile')
      .send(fullDraft({ summary: '在审还想改' }))
      .expect(409);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE);
    expect(body.message).toBe(PUT_ON_PENDING_MESSAGE);

    const after = (await readProfile('chg-f')) as MentorProfile;
    expect(draftFields(after)).toEqual(fieldsBefore);
  });

  it('判据 6：status=0 提 type=2（想跳过草稿）→ 409 / 31103，无申请行落库', async () => {
    await setStatus('chg-g', 0);

    const response = await api('chg-g')
      .post('/mentor-applications/profile-change')
      .send({ summary: '想跳过草稿' })
      .expect(409);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE);
    expect(body.message).toBe(SUBMIT_ON_DRAFT_MESSAGE);
    expect(await applicationRows('chg-g')).toHaveLength(0);
  });

  it('判据 7：status=1 / 4 / 5 提 type=2 → 各 409 / 31103，无申请行落库', async () => {
    const expectations: Array<[number, string]> = [
      [1, SUBMIT_ON_PENDING_MESSAGE],
      [4, SUBMIT_NOT_ELIGIBLE_MESSAGE],
      [5, SUBMIT_NOT_ELIGIBLE_MESSAGE],
    ];
    for (const [status, message] of expectations) {
      await setStatus('chg-g', status);
      const response = await api('chg-g')
        .post('/mentor-applications/profile-change')
        .send({ summary: `status=${status} 想提` })
        .expect(409);
      const body = response.body as ResponseEnvelope<null>;
      expect(body.code).toBe(ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE);
      expect(body.message).toBe(message);
      expect(await applicationRows('chg-g')).toHaveLength(0);
    }
  });

  it('判据 8：无档案提 type=2 → 404 / 31102', async () => {
    const response = await api('chg-none')
      .post('/mentor-applications/profile-change')
      .send({ summary: '没档案也想提' })
      .expect(404);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.MENTOR_PROFILE_NOT_FOUND);
    expect(body.message).toBe(PROFILE_NOT_FOUND_MESSAGE);
    expect(await readProfile('chg-none')).toBeNull();
    expect(await applicationRows('chg-none')).toHaveLength(0);
  });

  it('判据 9：personType=student 提 type=2 → 403 / 10003（不是 404）', async () => {
    const response = await api('chg-stu')
      .post('/mentor-applications/profile-change')
      .send({ summary: '学生也想提' })
      .expect(403);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.FORBIDDEN);
    expect(body.message).toBe(MENTOR_ONLY_MESSAGE);
    expect(await applicationRows('chg-stu')).toHaveLength(0);
  });

  it('判据 10：R58 去重——已有 status=2 的在审 type=2，再提 → 409 / 31106，第二条不落库', async () => {
    const first = await submitChange('chg-d', { summary: '第一条提案' });
    expect(first.status).toBe(2);

    const response = await api('chg-d')
      .post('/mentor-applications/profile-change')
      .send({ summary: '第二条提案' })
      .expect(409);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.MENTOR_APPLICATION_IN_FLIGHT);
    expect(body.message).toBe(IN_FLIGHT_MESSAGE);
    expect(await applicationRows('chg-d')).toHaveLength(1);
  });

  it('判据 11：R58 边界——上条审到 5 SC_REJECTED 后再提，仍 409 / 31106（5 算在审）', async () => {
    const rows = await applicationRows('chg-d');
    expect(rows).toHaveLength(1);
    const first = rows[0];
    await review(
      'chg-college-admin',
      first.id,
      'college-review',
      'approve',
      '本院过',
    );
    await review(
      'chg-sc-admin',
      first.id,
      'sc-review',
      'reject',
      '驳回，退二级学院重审',
    );
    expect((await readApp(first.id)).status).toBe(5);

    const response = await api('chg-d')
      .post('/mentor-applications/profile-change')
      .send({ summary: '驳回后想再提' })
      .expect(409);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.MENTOR_APPLICATION_IN_FLIGHT);
    expect(await applicationRows('chg-d')).toHaveLength(1);
  });

  it('判据 12：R58 边界——上条审到 3 COLLEGE_REJECTED 后再提 → 201（3 是停留态）', async () => {
    const rows = await applicationRows('chg-d');
    expect(rows).toHaveLength(1);
    const first = rows[0];
    // R54 的出口：5 → 二级学院重审不通过 → 3
    await review(
      'chg-college-admin',
      first.id,
      'college-review',
      'reject',
      '重审不通过，退回申请人',
    );
    expect((await readApp(first.id)).status).toBe(3);

    chgDApp2 = await submitChange('chg-d', { summary: '退回后重新提的' });
    expect(chgDApp2.status).toBe(2);
    const all = await applicationRows('chg-d');
    expect(all).toHaveLength(2);
    expect(all[0].id).toBe(first.id);
    expect(all[1].id).toBe(chgDApp2.id);
  });

  it('判据 13：提案被拒（college reject → 3）——MentorProfile 7 字段逐字不变、status 仍 2', async () => {
    const before = (await readProfile('chg-b')) as MentorProfile;
    expect(before.status).toBe(2);
    const fieldsBefore = draftFields(before);

    const rejected = await submitChange('chg-b', { summary: '待拒提案' });
    await review(
      'chg-college-admin',
      rejected.id,
      'college-review',
      'reject',
      '材料不实，退回',
    );

    const row = await readApp(rejected.id);
    expect(row.status).toBe(3);
    const after = (await readProfile('chg-b')) as MentorProfile;
    expect(draftFields(after)).toEqual(fieldsBefore);
    expect(after.status).toBe(2);
  });

  it('判据 14：提案被撤回（withdraw → 7）——MentorProfile 逐字不变、status 仍 2', async () => {
    const before = (await readProfile('chg-c')) as MentorProfile;
    expect(before.status).toBe(2);
    const fieldsBefore = draftFields(before);

    const withdrawn = await submitChange('chg-c', { summary: '待撤提案' });
    await api('chg-c')
      .post(`/mentor-applications/${withdrawn.id.toString()}/withdraw`)
      .send({})
      .expect(200);

    const row = await readApp(withdrawn.id);
    expect(row.status).toBe(7);
    const after = (await readProfile('chg-c')) as MentorProfile;
    expect(draftFields(after)).toEqual(fieldsBefore);
    expect(after.status).toBe(2);
  });

  it('判据 15：留痕——6 APPROVED 后 SysOpLog 两行：application + mentorProfile，before/after 完整 7 字段', async () => {
    const rows = await prisma.client.sysOpLog.findMany({
      where: {
        module: 'mentor-application',
        action: 'sc-review',
        status: 1,
        OR: [
          { targetType: 'application', targetId: chgAApp.id.toString() },
          { targetType: 'mentorProfile', targetId: chgAProfileId.toString() },
        ],
      },
      orderBy: { id: 'asc' },
    });
    expect(rows).toHaveLength(2);

    // 行 1：targetType='application'，Task 14 §4 的形状
    const [row1, row2] = rows;
    expect(row1.targetType).toBe('application');
    expect(row1.targetId).toBe(chgAApp.id.toString());
    const before1 = row1.before as {
      status: number;
      collegeReview: ReviewRecord | null;
      scReview: ReviewRecord | null;
    };
    expect(before1.status).toBe(4);
    expect(before1.scReview).toBeNull();
    const after1 = row1.after as typeof before1;
    expect(after1.status).toBe(6);
    expect(after1.scReview?.decision).toBe('approve');

    // 行 2：targetType='mentorProfile'，7 个可填报字段的旧值 / 新值完整快照
    expect(row2.targetType).toBe('mentorProfile');
    expect(row2.targetId).toBe(chgAProfileId.toString());
    expect(row2.before).toEqual({
      researchFields: ['创新创业', '人工智能'],
      summary: '个人简介一版',
      achievements: '研究成果一版',
      guidanceExperience: '指导经验一版',
      affiliateOrg: null,
      socialRoles: null,
      professionalTitle: '职称一版',
    });
    expect(row2.after).toEqual({
      researchFields: chgASnapshot.researchFields,
      summary: chgASnapshot.summary,
      achievements: chgASnapshot.achievements,
      guidanceExperience: chgASnapshot.guidanceExperience,
      affiliateOrg: chgASnapshot.affiliateOrg,
      socialRoles: chgASnapshot.socialRoles,
      professionalTitle: chgASnapshot.professionalTitle,
    });
  });

  it('判据 16：提案生效后 PUT 仍 409 / 31103（status 还是 2），改字段继续走 type=2', async () => {
    const response = await api('chg-a')
      .put('/mentor/profile')
      .send(fullDraft({ summary: '生效后还想直接改' }))
      .expect(409);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE);
    expect(body.message).toBe(PUT_ON_APPROVED_MESSAGE);
    expect(((await readProfile('chg-a')) as MentorProfile).status).toBe(2);
  });

  it('判据 17：R49——内校提案的 affiliateOrg / socialRoles 快照为 null，生效后仍是 null', async () => {
    const e = await submitChange('chg-e', {
      summary: 'R49 内校提案',
      affiliateOrg: '某某研究院',
      socialRoles: '某某学会理事',
    });

    // 两处都要：① 提案快照里就置了 null（R49 在合并时收口）
    const snapshot = (await readApp(e.id)).snapshot as unknown as {
      affiliateOrg: string | null;
      socialRoles: string | null;
    };
    expect(snapshot.affiliateOrg).toBeNull();
    expect(snapshot.socialRoles).toBeNull();

    await review('chg-college-admin', e.id, 'college-review', 'approve', '过');
    await review('chg-sc-admin', e.id, 'sc-review', 'approve', '过');

    // ② 生效后仍是 null（写回的就是快照里的 null）
    const after = (await readProfile('chg-e')) as MentorProfile;
    expect(after.affiliateOrg).toBeNull();
    expect(after.socialRoles).toBeNull();
    expect(after.summary).toBe('R49 内校提案');
    expect(after.status).toBe(2);
  });

  it('判据 18：快照不可变 + 写回数据源三方比对——提交后 snapshot 逐字不变（Prisma 直查，含生效后）', async () => {
    const s1 = JSON.stringify((await readApp(chgDApp2.id)).snapshot);

    // 二级学院审核推进（type=2 不碰档案行），snapshot 不动
    await review(
      'chg-college-admin',
      chgDApp2.id,
      'college-review',
      'approve',
      '过',
    );
    const s2 = JSON.stringify((await readApp(chgDApp2.id)).snapshot);
    expect(s2).toBe(s1);

    // 生效前的档案旧值（三方比对的第二方，Prisma 直查）
    const profileBefore = draftFields(
      (await readProfile('chg-d')) as MentorProfile,
    );

    // 生效写回改了档案行，snapshot 仍逐字不变（落库后永不改写，红线 9）
    await review('chg-sc-admin', chgDApp2.id, 'sc-review', 'approve', '过');
    expect((await readApp(chgDApp2.id)).status).toBe(6);
    const s3 = JSON.stringify((await readApp(chgDApp2.id)).snapshot);
    expect(s3).toBe(s1);

    // 写回数据源三方比对（P2-1）：生效后 7 字段 = snapshot 的值（数据源是快照，
    // 不是重读当前行），且 ≠ 生效前的 profileBefore 旧值（写回确实落了新值）
    const merged = (await readApp(chgDApp2.id))
      .snapshot as unknown as DraftFields & { mentorType: string };
    const after = draftFields((await readProfile('chg-d')) as MentorProfile);
    expect(after).toEqual({
      researchFields: merged.researchFields,
      summary: merged.summary,
      achievements: merged.achievements,
      guidanceExperience: merged.guidanceExperience,
      affiliateOrg: merged.affiliateOrg,
      socialRoles: merged.socialRoles,
      professionalTitle: merged.professionalTitle,
    });
    expect(after).not.toEqual(profileBefore);
  });

  it('判据 19：R58 并发去重——同一人 Promise.all 双发，恰 1×201 + 1×409 / 31106，库里恰一行 type=2 在审（3 轮都稳）', async () => {
    // 判据 7 把 chg-g 的档案拨到过 5；并发回归要从可提交态（status=2）出发
    await setStatus('chg-g', 2);

    for (let round = 1; round <= 3; round += 1) {
      const body = { summary: `并发去重第 ${round} 轮` };
      const [r1, r2] = await Promise.all([
        api('chg-g').post('/mentor-applications/profile-change').send(body),
        api('chg-g').post('/mentor-applications/profile-change').send(body),
      ]);

      // 恰 1×201 + 1×409 / 31106（谁先抢到锁不定，排序后比）
      const statuses = [r1.status, r2.status].sort((a, b) => a - b);
      expect(statuses).toEqual([201, 409]);
      const loserResponse = r1.status === 409 ? r1 : r2;
      const loser = loserResponse.body as ResponseEnvelope<null>;
      expect(loser.code).toBe(ErrorCode.MENTOR_APPLICATION_IN_FLIGHT);
      expect(loser.message).toBe(IN_FLIGHT_MESSAGE);

      // 库里恰一行 type=2 且 status=2 的在审行（输家那单一行都不落）
      const rows = await applicationRows('chg-g');
      for (const row of rows) {
        expect(row.type).toBe(2);
      }
      const inFlight = rows.filter((row) => row.status === 2);
      expect(inFlight).toHaveLength(1);

      // 轮间清场：撤回赢家（→ 7 停留态），下一轮才能再提（R58 口径）
      await api('chg-g')
        .post(`/mentor-applications/${inFlight[0].id.toString()}/withdraw`)
        .send({})
        .expect(200);
      expect((await readApp(inFlight[0].id)).status).toBe(7);
    }
  });

  it('判据 20：docs:gen 85 路径 / 112 操作（不多不少）；profile-change 恰好 post 一条', () => {
    const document = buildDocument(app);
    const methodsOf = (path: string): string[] => {
      const item = document.paths[path] as Record<string, unknown> | undefined;
      if (item === undefined) {
        throw new Error(`文档里没有 ${path}`);
      }
      return Object.keys(item)
        .filter((key) => HTTP_METHODS.has(key))
        .sort();
    };
    expect(methodsOf('/mentor-applications/profile-change')).toEqual(['post']);

    const paths = Object.keys(document.paths);
    // Task 16+17 的佐证材料面加了 4 路径 / 5 操作：42/58 → 46/63；
    // Task 18 的后台改档 PUT /mentor/profiles/{id} 再加 1 路径 / 1 操作：46/63 → 47/64；
    // Task 21 的时段管理（/mentor/slots 与 /mentor/slots/{id}，各 get+post / put+delete）
    // 再加 2 路径 / 4 操作：47/64 → 49/68；
    // Task 22 的导师检索（/mentors 与 /mentors/{id}，各 get）再加 2 路径 / 2 操作：49/68 → 51/70；
    // Task 23 的发起预约 POST /appointments 再加 1 路径 / 1 操作：51/70 → 52/71；
    // Task 24 的预约处理（confirm / reject / reschedule）再加 3 路径 / 3 操作：52/71 → 55/74；
    // Task 25 的学生取消 POST /appointments/{id}/cancel 再加 1 路径 / 1 操作：55/74 → 56/75；
    // Task 26 的指导记录 POST + GET /appointments/{id}/record 再加 1 路径 / 2 操作：56/75 → 57/77；
    // Task 27 的学生确认记录 / 提异议（confirm-record、dispute，各 1 个 POST）
    // 再加 2 路径 / 2 操作：57/77 → 59/79；
    // Task 28 的异议复核 POST /appointments/{id}/adjudicate 再加 1 路径 / 1 操作：
    // 59/79 → 60/80；
    // Task 29 的预约材料 / 过程材料再加 4 路径 / 5 操作：60/80 → 64/85；
    // Task 30 的预约列表 GET /appointments（与既有 POST 同路径）+ 详情
    // GET /appointments/{id} 再加 1 路径 / 2 操作：64/85 → 65/87；
    // P3 Task 34 的评价再加 2 路径 / 3 操作（`/appointments/{id}/review` 的 post+get、
    // `/mentors/{mentorId}/reviews` 的 get）：65/87 → 67/90；
    // P3 Task 36 的成果再加 2 路径 / 4 操作（`/mentors/{mentorId}/achievements` 的
    // post+get、`/mentors/{mentorId}/achievements/{achievementId}` 的 patch+delete）：67/90 → 69/94
    // P4 的统计 / 导出 / 归档：85/112 → 88/118
    // （`/stats/*` 5 条、4 条 `/export`、`/me/records/export`，以及归档的
    // `/archives`、`/archives/purge`、`/archives/{id}`）
    // P5 的学期规则 / 消息 / 学生成果：88/118 → 100/133
    expect(paths).toHaveLength(100);
    let operations = 0;
    for (const path of paths) {
      operations += methodsOf(path).length;
    }
    expect(operations).toBe(133);
  });

  it('判据 21（R28）：旧快照缺 professionalTitle 键 → GET 详情不报错，归一为 null', async () => {
    // 造一条正常的提案，再把快照里的 professionalTitle 键删掉——模拟 Task 20c
    // 之前落库的历史快照（那时 MentorProfileDraft 还没有这个字段）
    const created = await submitChange('chg-g', { summary: '旧快照兼容' });
    const stored = (await readApp(created.id)).snapshot as Record<
      string,
      unknown
    >;
    expect(stored.professionalTitle).toBe('职称一版');
    const legacy: Record<string, unknown> = { ...stored };
    delete legacy.professionalTitle;
    await prisma.client.mentorApplication.update({
      where: { id: created.id },
      data: { snapshot: legacy },
    });

    const response = await api('chg-sc-admin')
      .get(`/mentor-applications/${created.id.toString()}`)
      .expect(200);
    const data = (
      response.body as ResponseEnvelope<MentorApplicationResponseDto>
    ).data;
    // 缺键不抛错：归一为 null，其余字段照常
    expect(data.snapshot.professionalTitle).toBeNull();
    expect(data.snapshot.summary).toBe(stored.summary);
    expect(data.snapshot.researchFields).toEqual(stored.researchFields);
  });
});

/**
 * 清残留。走裸 SQL（照 mentor-application.e2e-spec.ts 的同名函数）：
 * 清库是测试的运维动作，不是业务写入。顺序按外键拓扑序。
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
