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
import type { ReviewRecord } from '../src/modules/mentor-application/dto/review.dto';
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
 * 两级审核流 (e2e) —— brief §5 的 19 条判据（判据 19 = 路由面 + docs:gen
 * 47 路径 / 64 操作——Task 15 的 profile-change 路由把 41/57 顶到 42/58，
 * Task 16+17 的佐证材料面再加 4 路径 / 5 操作顶到 46/63，
 * Task 18 的后台改档 PUT /mentor/profiles/{id} 再加 1 路径 / 1 操作顶到 47/64，
 * 总数在这里钉一份，另由门槛命令核）。
 *
 * 用例执行顺序就是编号顺序（共享库态、maxWorkers:1 串行）：
 * 判据 4/5 的「5」前置态**直改库**造——用 sc-reject 造态会带上 R73 的副作用，
 * 探针 6 就会连判据 4 一起打红（探针的红线是判据 3 / 18）；判据 7 复用
 * 判据 1/3/4/6 留下的 4/5/6/7 四态；判据 10/12 复用判据 3 留下的 5 态；
 * 判据 18 接判据 3 的 5 态收尾。
 *
 * 审核者全部走真实权限路径（brief §0.2 权限码分流，不看角色名）：
 * - `college-admin-a` / `college-admin-b`：deptAndChildren，持 review-college + list；
 * - `reviewer-wide`：**all 角色范围** + review-college，挂 collegeA——判据 10 的
 *   「审外院」靠 `@DataScope('dept')` 天花板夹窄（clampDataScope 求窄）实现，
 *   天花板是它唯一的夹窄机制，探针 3（'dept'→'all'）就是靠它转红；
 * - `sc-admin`：all，持 review-sc + list。
 */

const SYNCED_AT = new Date('2026-10-27T00:00:00.000Z');

const TRANSITION_INVALID_MESSAGE = '当前状态不允许该操作';
const APPLICATION_NOT_FOUND_MESSAGE = '入驻申请不存在';
const NOT_SUBMITTABLE_MESSAGE = '导师档案当前状态不允许提交入驻申请';

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

/** 列表响应的最小形状（判据 17 只看 applicantId 集合） */
interface MentorApplicationPage {
  list: MentorApplicationResponseDto[];
  total: number;
  page: number;
  pageSize: number;
}

describe('两级审核流 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let admin: SeededUser;
  let adminApi: E2eApi;

  /** 部门树：root「总公司」← collegeA ← subA1；root ← collegeB */
  const deptIds = new Map<string, bigint>();
  /** 同步组织（runWithSyncWrite 造），deptId 挂到对应部门 */
  const orgIds = new Map<string, bigint>();

  const agents = new Map<string, E2eApi>();
  const people = new Map<string, SyncPerson>();
  const permissionIds = new Map<string, string>();

  /** 后面判据要接着看的申请行（编号顺序保证各自判据先赋值） */
  let a1App: MentorApplication;
  let a2App1: MentorApplication;
  let a3App: MentorApplication;
  let b1App1: MentorApplication;
  let b2App: MentorApplication;

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
    deptIds.set('root', root.id);
    for (const [key, name] of [
      ['collegeA', '审核流院A'],
      ['collegeB', '审核流院B'],
    ] as const) {
      deptIds.set(key, await createDept(name, root.id));
    }
    deptIds.set('subA1', await createDept('审核流系A1', dept('collegeA')));

    // 同步层的行只有同步任务能写（SYNC_WRITE_FORBIDDEN）：造数走 runWithSyncWrite
    for (const [key, name, deptKey] of [
      ['orgA', '审核流组织A', 'collegeA'],
      ['orgA1', '审核流组织A1', 'subA1'],
      ['orgB', '审核流组织B', 'collegeB'],
    ] as const) {
      const org = await runWithSyncWrite(() =>
        prisma.client.syncOrgUnit.create({
          data: {
            code: key.toUpperCase(),
            name,
            deptId: dept(deptKey),
            syncedAt: SYNCED_AT,
            createdBy: 0n,
            updatedBy: 0n,
          },
        }),
      );
      orgIds.set(key, org.id);
    }

    // 四个角色：导师权限全走一份；三个审核者各持各的权限码 + 数据范围
    const mentorRole = await createRoleWithCodes(
      '审核流导师角色',
      'mentor',
      'self',
      [
        'mentor-application:submit',
        'mentor-application:withdraw',
        'mentor:profile',
        'mentor:profile-update',
      ],
    );
    const collegeRoleCodes = [
      'mentor-application:review-college',
      'mentor-application:list',
    ];
    const roleA = await createRoleWithCodes(
      '审核流院A管理员',
      'ma_college_a',
      'deptAndChildren',
      collegeRoleCodes,
    );
    const roleB = await createRoleWithCodes(
      '审核流院B管理员',
      'ma_college_b',
      'deptAndChildren',
      collegeRoleCodes,
    );
    const roleWide = await createRoleWithCodes(
      '审核流全范围审核员',
      'ma_wide',
      'all',
      collegeRoleCodes,
    );
    const roleSc = await createRoleWithCodes(
      '审核流双创管理员',
      'ma_sc',
      'all',
      ['mentor-application:review-sc', 'mentor-application:list'],
    );

    // 八个导师：a1 挂 orgA1（下级），a2-a5 挂 orgA，b1-b3 挂 orgB
    const mentors: Array<[string, string, string]> = [
      ['mentor-a1', 'orgA1', 'collegeA'],
      ['mentor-a2', 'orgA', 'collegeA'],
      ['mentor-a3', 'orgA', 'collegeA'],
      ['mentor-a4', 'orgA', 'collegeA'],
      ['mentor-a5', 'orgA', 'collegeA'],
      ['mentor-b1', 'orgB', 'collegeB'],
      ['mentor-b2', 'orgB', 'collegeB'],
      ['mentor-b3', 'orgB', 'collegeB'],
    ];
    for (const [login, orgKey, deptKey] of mentors) {
      const person = await runWithSyncWrite(() =>
        prisma.client.syncPerson.create({
          data: {
            login,
            realName: login,
            personType: 'internalMentor',
            orgUnitId: org(orgKey),
            syncedAt: SYNCED_AT,
            createdBy: 0n,
            updatedBy: 0n,
          },
        }),
      );
      people.set(login, person);
      const user = await seedUser(prisma, {
        username: login,
        deptId: dept(deptKey),
      });
      await linkUserRole(user.userId, BigInt(mentorRole.id));
      await loginFor(login);
    }

    // 四个审核者（不需要 SyncPerson：审核走的是账号 + 权限码 + 数据范围）
    const reviewers: Array<[string, string, RoleResponseDto]> = [
      ['college-admin-a', 'collegeA', roleA],
      ['college-admin-b', 'collegeB', roleB],
      ['reviewer-wide', 'collegeA', roleWide],
      ['sc-admin', 'root', roleSc],
    ];
    for (const [login, deptKey, role] of reviewers) {
      const user = await seedUser(prisma, {
        username: login,
        deptId: dept(deptKey),
      });
      await linkUserRole(user.userId, BigInt(role.id));
      await loginFor(login);
    }

    // 档案全部先建好（status=0 DRAFT）：各判据只管 POST 送审
    for (const [login] of mentors) {
      await api(login).put('/mentor/profile').send(fullDraft()).expect(200);
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

  function dept(key: string): bigint {
    const id = deptIds.get(key);
    if (id === undefined) {
      throw new Error(`没有 ${key} 部门`);
    }
    return id;
  }

  function org(key: string): bigint {
    const id = orgIds.get(key);
    if (id === undefined) {
      throw new Error(`没有 ${key} 组织`);
    }
    return id;
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

  /** 直改库置申请 status（判据 4/5 的「5」前置态；R73 要求此时档案停在 1） */
  async function setApplicationStatus(
    id: bigint,
    status: number,
  ): Promise<void> {
    await prisma.client.mentorApplication.update({
      where: { id },
      data: { status },
    });
  }

  /** 送审（Task 13 的 POST）：返回落库行（status 恒 2） */
  async function submitApp(login: string): Promise<MentorApplication> {
    const response = await api(login)
      .post('/mentor-applications')
      .send({})
      .expect(201);
    const data = (
      response.body as ResponseEnvelope<MentorApplicationResponseDto>
    ).data;
    expect(data.status).toBe(2);
    const rows = await applicationRows(login);
    return rows[rows.length - 1];
  }

  /** 直改库把申请行推到 5 SC_REJECTED，档案保持 1（R73 的真实停驻形态） */
  async function seedAtScRejected(login: string): Promise<MentorApplication> {
    const row = await submitApp(login);
    await setApplicationStatus(row.id, 5);
    expect(((await readProfile(login)) as MentorProfile).status).toBe(1);
    return readApp(row.id);
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

  function expectReviewRecord(
    record: ReviewRecord | null,
    decision: 'approve' | 'reject',
    comment: string,
  ): void {
    expect(record).not.toBeNull();
    const value = record as ReviewRecord;
    expect(value.decision).toBe(decision);
    expect(value.comment).toBe(comment);
    expect(typeof value.reviewerId).toBe('string');
    expect(value.reviewerName.length).toBeGreaterThan(0);
    expect(value.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }

  it('判据 1：通过路径 2 → college approve → 4 → sc approve → 6；三步成功，终态 6，MentorProfile.status → 2', async () => {
    a1App = await submitApp('mentor-a1');
    const profileAfterSubmit = (await readProfile(
      'mentor-a1',
    )) as MentorProfile;
    expect(profileAfterSubmit.status).toBe(1);

    const approve1 = await api('college-admin-a')
      .post(`/mentor-applications/${a1App.id.toString()}/college-review`)
      .send({ decision: 'approve', comment: '材料齐全，同意' })
      .expect(200);
    const data1 = (
      approve1.body as ResponseEnvelope<MentorApplicationResponseDto>
    ).data;
    expect(data1.status).toBe(4);
    expectReviewRecord(data1.collegeReview, 'approve', '材料齐全，同意');
    expect(data1.scReview).toBeNull();

    const row4 = await readApp(a1App.id);
    expect(row4.status).toBe(4);
    expectReviewRecord(
      row4.collegeReview as unknown as ReviewRecord,
      'approve',
      '材料齐全，同意',
    );
    expect(row4.scReview).toBeNull();
    // 落点 4（还在审）档案不动
    expect(((await readProfile('mentor-a1')) as MentorProfile).status).toBe(1);

    // 模拟「教师只有 teacher 角色」：摘掉 mentor，审核通过后应由同一事务补回
    const applicantUser = await prisma.client.sysUser.findFirst({
      where: { username: 'mentor-a1' },
    });
    const mentorRole = await prisma.client.sysRole.findFirst({
      where: { code: 'mentor' },
    });
    await prisma.client.sysUserRole.deleteMany({
      where: { userId: applicantUser?.id, roleId: mentorRole?.id },
    });

    const approve2 = await api('sc-admin')
      .post(`/mentor-applications/${a1App.id.toString()}/sc-review`)
      .send({ decision: 'approve', comment: '同意入驻' })
      .expect(200);
    const data2 = (
      approve2.body as ResponseEnvelope<MentorApplicationResponseDto>
    ).data;
    expect(data2.status).toBe(6);
    expectReviewRecord(data2.scReview, 'approve', '同意入驻');

    const row6 = await readApp(a1App.id);
    expect(row6.status).toBe(6);
    // 副作用表：落点 6 → MentorProfile.status = 2 APPROVED
    expect(((await readProfile('mentor-a1')) as MentorProfile).status).toBe(2);

    // 审核通过 → mentor 角色由 applyTransition 同事务补回
    expect(
      await prisma.client.sysUserRole.findFirst({
        where: { userId: applicantUser?.id, roleId: mentorRole?.id },
      }),
    ).not.toBeNull();
  });

  it('判据 2：退回路径 2 → college reject → 3；MentorProfile.status → 3；collegeReview.comment 非空', async () => {
    a2App1 = await submitApp('mentor-a2');

    const response = await api('college-admin-a')
      .post(`/mentor-applications/${a2App1.id.toString()}/college-review`)
      .send({ decision: 'reject', comment: '材料不全，退回补充' })
      .expect(200);
    const data = (
      response.body as ResponseEnvelope<MentorApplicationResponseDto>
    ).data;
    expect(data.status).toBe(3);
    expect(data.collegeReview?.comment).toBe('材料不全，退回补充');
    expect(data.collegeReview?.comment.length).toBeGreaterThan(0);

    const row = await readApp(a2App1.id);
    expect(row.status).toBe(3);
    expectReviewRecord(
      row.collegeReview as unknown as ReviewRecord,
      'reject',
      '材料不全，退回补充',
    );
    // 副作用表：落点 3 → 3 REJECTED（退回申请人）
    expect(((await readProfile('mentor-a2')) as MentorProfile).status).toBe(3);
  });

  it('判据 3：双创驳回 4 → sc reject → 5；MentorProfile.status 不动，仍 1 PENDING（R73）', async () => {
    b1App1 = await submitApp('mentor-b1');

    await api('college-admin-b')
      .post(`/mentor-applications/${b1App1.id.toString()}/college-review`)
      .send({ decision: 'approve', comment: '本院审核通过' })
      .expect(200);
    expect((await readApp(b1App1.id)).status).toBe(4);
    expect(((await readProfile('mentor-b1')) as MentorProfile).status).toBe(1);

    const response = await api('sc-admin')
      .post(`/mentor-applications/${b1App1.id.toString()}/sc-review`)
      .send({ decision: 'reject', comment: '研究方向不符，退回二级学院重审' })
      .expect(200);
    const data = (
      response.body as ResponseEnvelope<MentorApplicationResponseDto>
    ).data;
    expect(data.status).toBe(5);
    expectReviewRecord(
      data.scReview,
      'reject',
      '研究方向不符，退回二级学院重审',
    );

    const row = await readApp(b1App1.id);
    expect(row.status).toBe(5);
    // R73：落点 5 不写 MentorProfile.status（仍 1 PENDING，不是 → 3）
    expect(((await readProfile('mentor-b1')) as MentorProfile).status).toBe(1);
  });

  it('判据 4：R54 重审 5 → college approve → 4；MentorProfile.status 不动，仍 1 PENDING', async () => {
    b2App = await seedAtScRejected('mentor-b2');
    expect(b2App.status).toBe(5);

    const response = await api('college-admin-b')
      .post(`/mentor-applications/${b2App.id.toString()}/college-review`)
      .send({ decision: 'approve', comment: '已核材料无误，再送双创' })
      .expect(200);
    const data = (
      response.body as ResponseEnvelope<MentorApplicationResponseDto>
    ).data;
    expect(data.status).toBe(4);
    expectReviewRecord(data.collegeReview, 'approve', '已核材料无误，再送双创');

    const row = await readApp(b2App.id);
    expect(row.status).toBe(4);
    // 重审通过只推申请行；档案在 5/4 之间都不动
    expect(((await readProfile('mentor-b2')) as MentorProfile).status).toBe(1);
  });

  it('判据 5：R54 重审不通过 5 → college reject → 3；MentorProfile.status → 3 REJECTED（这一跳才是退回申请人）', async () => {
    const seeded = await seedAtScRejected('mentor-b3');
    expect(seeded.status).toBe(5);

    const response = await api('college-admin-b')
      .post(`/mentor-applications/${seeded.id.toString()}/college-review`)
      .send({ decision: 'reject', comment: '重审不通过，退回申请人' })
      .expect(200);
    const data = (
      response.body as ResponseEnvelope<MentorApplicationResponseDto>
    ).data;
    expect(data.status).toBe(3);

    const row = await readApp(seeded.id);
    expect(row.status).toBe(3);
    expect(((await readProfile('mentor-b3')) as MentorProfile).status).toBe(3);
  });

  it('判据 6：撤回 2 → withdraw → 7；MentorProfile.status → 0 DRAFT', async () => {
    a3App = await submitApp('mentor-a3');

    const response = await api('mentor-a3')
      .post(`/mentor-applications/${a3App.id.toString()}/withdraw`)
      .send({})
      .expect(200);
    const data = (
      response.body as ResponseEnvelope<MentorApplicationResponseDto>
    ).data;
    expect(data.status).toBe(7);

    const row = await readApp(a3App.id);
    expect(row.status).toBe(7);
    // 副作用表：落点 7 → 0 DRAFT（撤回=拿回来改）
    expect(((await readProfile('mentor-a3')) as MentorProfile).status).toBe(0);
  });

  it('判据 7：不可撤——4 / 5 / 6 / 7 调 withdraw 各 409 / 31105', async () => {
    // b2@4、b1@5、a1@6、a3@7（复用判据 1/3/4/6 留下的四态），各撤自己的
    const cases: Array<[string, bigint, number]> = [
      ['mentor-b2', b2App.id, 4],
      ['mentor-b1', b1App1.id, 5],
      ['mentor-a1', a1App.id, 6],
      ['mentor-a3', a3App.id, 7],
    ];
    for (const [login, appId, expectedStatus] of cases) {
      expect((await readApp(appId)).status).toBe(expectedStatus);
      const response = await api(login)
        .post(`/mentor-applications/${appId.toString()}/withdraw`)
        .send({})
        .expect(409);
      const body = response.body as ResponseEnvelope<null>;
      expect(body.code).toBe(ErrorCode.MENTOR_APPLICATION_TRANSITION_INVALID);
      expect(body.message).toBe(TRANSITION_INVALID_MESSAGE);
      // 行一个字都没动
      expect((await readApp(appId)).status).toBe(expectedStatus);
    }
  });

  it('判据 8：非法流转——3 调 sc-review（想直接 → 6）409 / 31105，行状态仍是 3', async () => {
    expect((await readApp(a2App1.id)).status).toBe(3);

    const response = await api('sc-admin')
      .post(`/mentor-applications/${a2App1.id.toString()}/sc-review`)
      .send({ decision: 'approve', comment: '想把退回的单直接审掉' })
      .expect(409);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.MENTOR_APPLICATION_TRANSITION_INVALID);
    expect(body.message).toBe(TRANSITION_INVALID_MESSAGE);

    const row = await readApp(a2App1.id);
    expect(row.status).toBe(3);
    expect(((await readProfile('mentor-a2')) as MentorProfile).status).toBe(3);
  });

  it('判据 9：越权 ①——持 review-college 的 college-admin-a 调 sc-review → 403 / 10003，消息含 mentor-application:review-sc', async () => {
    const response = await api('college-admin-a')
      .post(`/mentor-applications/${b2App.id.toString()}/sc-review`)
      .send({ decision: 'approve', comment: '越权想审双创的活' })
      .expect(403);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.FORBIDDEN);
    expect(body.message).toContain('mentor-application:review-sc');

    expect((await readApp(b2App.id)).status).toBe(4);
  });

  it('判据 10：越权 ②——审外院导师的申请 → 403 / 10003（assertDeptVisible），不是 404；详情同判', async () => {
    // reviewer-wide 的角色范围是 all，`@DataScope('dept')` 天花板把它夹回
    // collegeA 及下级；b1 的申请人在 collegeB → 403。注意 b1@5 对
    // college-review 有合法边（5 → 3），仍先 403——403 先于 409
    const response = await api('reviewer-wide')
      .post(`/mentor-applications/${b1App1.id.toString()}/college-review`)
      .send({ decision: 'reject', comment: '外院的单不该我审' })
      .expect(403);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.FORBIDDEN);
    expect(body.message).toBe('无权限');
    expect((await readApp(b1App1.id)).status).toBe(5);

    // 详情入口同一条院系判定（天花板 'all' + assertDeptVisible）——
    // deptAndChildren 的 college-admin-a 看外院单 403、看本院及下级 200。
    // reviewer-wide 是 all 角色：详情 / 列表的天花板 'all' 不夹窄，all 角色
    // 本来就该看全校，它的判越权点只在 college-review 的 'dept' 天花板（上）
    await api('college-admin-a')
      .get(`/mentor-applications/${b1App1.id.toString()}`)
      .expect(403);
    await api('college-admin-a')
      .get(`/mentor-applications/${a1App.id.toString()}`)
      .expect(200);
  });

  it('判据 11：越权 ③——持 review-sc 但无 review-college 的 sc-admin 调 college-review → 403 / 10003，消息含 mentor-application:review-college', async () => {
    const response = await api('sc-admin')
      .post(`/mentor-applications/${a2App1.id.toString()}/college-review`)
      .send({ decision: 'approve', comment: '越权想替二级学院审' })
      .expect(403);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.FORBIDDEN);
    expect(body.message).toContain('mentor-application:review-college');

    expect((await readApp(a2App1.id)).status).toBe(3);
  });

  it('判据 12：comment 不传 / 空串 / 501 字符 → 各 400 / 10001，data.fields 点名 comment', async () => {
    // R57：approve / reject 两个决定的 comment 都必填，三种坏法逐条发
    const bodies: Array<Record<string, unknown>> = [
      { decision: 'reject' },
      { decision: 'reject', comment: '' },
      { decision: 'reject', comment: 'x'.repeat(501) },
      { decision: 'approve' },
      { decision: 'approve', comment: '' },
    ];
    for (const body of bodies) {
      const response = await api('college-admin-a')
        .post(`/mentor-applications/${b1App1.id.toString()}/college-review`)
        .send(body)
        .expect(400);
      const envelope = response.body as ResponseEnvelope<{
        fields: FieldErrorDto[];
      }>;
      expect(envelope.code).toBe(ErrorCode.PARAM_INVALID);
      expect(envelope.data.fields.some((f) => f.field === 'comment')).toBe(
        true,
      );
    }
    expect((await readApp(b1App1.id)).status).toBe(5);
  });

  it('判据 13：撤自己的 → 200；撤别人的 → 403 / 10003（self 天花板 + 身份链）', async () => {
    const own = await submitApp('mentor-a5');
    const ownResponse = await api('mentor-a5')
      .post(`/mentor-applications/${own.id.toString()}/withdraw`)
      .send({})
      .expect(200);
    expect(
      (ownResponse.body as ResponseEnvelope<MentorApplicationResponseDto>).data
        .status,
    ).toBe(7);

    const a4App = await submitApp('mentor-a4');
    const otherResponse = await api('mentor-a5')
      .post(`/mentor-applications/${a4App.id.toString()}/withdraw`)
      .send({})
      .expect(403);
    const body = otherResponse.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.FORBIDDEN);
    expect(body.message).toBe('无权限');
    // 别人的单一个字都没动
    expect((await readApp(a4App.id)).status).toBe(2);
    expect(((await readProfile('mentor-a4')) as MentorProfile).status).toBe(1);
  });

  it('判据 14：退回后能重交——3 后改档案 → POST 201，新申请 status=2', async () => {
    expect((await readApp(a2App1.id)).status).toBe(3);

    await api('mentor-a2')
      .put('/mentor/profile')
      .send(fullDraft({ summary: '退回后改过的简介' }))
      .expect(200);

    const a2App2 = await submitApp('mentor-a2');
    expect(a2App2.status).toBe(2);

    const rows = await applicationRows('mentor-a2');
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(a2App1.id);
    expect(rows[0].status).toBe(3);
    expect(((await readProfile('mentor-a2')) as MentorProfile).status).toBe(1);
  });

  it('判据 15：留痕——每次动作多一行，targetType=application、before/after 完整快照且链式相接（a1 成功两跳）', async () => {
    // status=1 的成功两跳链式核（判据 7 在 a1 单上留下的被拒行归判据 16 口径）
    const rows = await prisma.client.sysOpLog.findMany({
      where: {
        targetType: 'application',
        targetId: a1App.id.toString(),
        status: 1,
      },
      orderBy: { id: 'asc' },
    });
    expect(rows).toHaveLength(2);

    const [hop1, hop2] = rows;
    expect(hop1.module).toBe('mentor-application');
    expect(hop1.action).toBe('college-review');
    expect(hop1.status).toBe(1);
    expect(hop1.method).toBe('POST');
    expect(typeof hop1.durationMs).toBe('number');
    expect(hop1.before).toEqual({
      status: 2,
      collegeReview: null,
      scReview: null,
    });
    const after1 = hop1.after as {
      status: number;
      collegeReview: ReviewRecord | null;
      scReview: ReviewRecord | null;
    };
    expect(after1.status).toBe(4);
    expectReviewRecord(after1.collegeReview, 'approve', '材料齐全，同意');
    expect(after1.scReview).toBeNull();

    expect(hop2.action).toBe('sc-review');
    expect(hop2.status).toBe(1);
    // 第二跳的 before 必须逐字等于第一跳的 after（完整快照链）
    expect(hop2.before).toEqual(hop1.after);
    const after2 = hop2.after as typeof after1;
    expect(after2.status).toBe(6);
    expectReviewRecord(after2.collegeReview, 'approve', '材料齐全，同意');
    expectReviewRecord(after2.scReview, 'approve', '同意入驻');
  });

  it('判据 16：被 31105 拒的那次也落日志（status=0、errorCode=31105、有 before 无 after）', async () => {
    // 判据 8 那次被拒的 sc-review
    const rows = await prisma.client.sysOpLog.findMany({
      where: {
        targetType: 'application',
        targetId: a2App1.id.toString(),
        status: 0,
      },
      orderBy: { id: 'asc' },
    });
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.module).toBe('mentor-application');
    expect(row.action).toBe('sc-review');
    expect(row.errorCode).toBe(ErrorCode.MENTOR_APPLICATION_TRANSITION_INVALID);
    expect(row.errorMsg).toBe(TRANSITION_INVALID_MESSAGE);
    const before = row.before as {
      status: number;
      collegeReview: ReviewRecord | null;
      scReview: ReviewRecord | null;
    };
    expect(before.status).toBe(3);
    expectReviewRecord(before.collegeReview, 'reject', '材料不全，退回补充');
    expect(before.scReview).toBeNull();
    expect(row.after).toBeNull();
  });

  it('判据 17：列表收窄——college_admin 只出本院及下级，sc_admin 出全校（天花板 all 不夹窄）', async () => {
    // 此刻库态：a1@6、a2#1@3、a2#2@2、a3@7、a4@2、a5@7、b1#1@5、b2@4、b3@3
    const collegeView = await api('college-admin-a')
      .get('/mentor-applications')
      .query({ page: 1, pageSize: 50 })
      .expect(200);
    const collegeBody =
      collegeView.body as ResponseEnvelope<MentorApplicationPage>;
    expect(collegeBody.data.total).toBe(6);
    const collegeApplicants = collegeBody.data.list
      .map((row) => row.applicantId)
      .sort();
    // 本院（collegeA）+ 下级（subA1 的 mentor-a1），一条外院的都不许有
    expect(collegeApplicants).toEqual(
      [
        personId('mentor-a1'),
        personId('mentor-a2'),
        personId('mentor-a2'),
        personId('mentor-a3'),
        personId('mentor-a4'),
        personId('mentor-a5'),
      ]
        .map((id) => id.toString())
        .sort(),
    );

    const scView = await api('sc-admin')
      .get('/mentor-applications')
      .query({ page: 1, pageSize: 50 })
      .expect(200);
    const scBody = scView.body as ResponseEnvelope<MentorApplicationPage>;
    expect(scBody.data.total).toBe(9);
    expect(scBody.data.list.map((row) => row.applicantId).sort()).toEqual(
      [
        personId('mentor-a1'),
        personId('mentor-a2'),
        personId('mentor-a2'),
        personId('mentor-a3'),
        personId('mentor-a4'),
        personId('mentor-a5'),
        personId('mentor-b1'),
        personId('mentor-b2'),
        personId('mentor-b3'),
      ]
        .map((id) => id.toString())
        .sort(),
    );
  });

  it('判据 18：R73 的洞堵住——5 时重交 409 / 31103 无新行；重审不通过 → 3 → 档案 3 → 再交 201', async () => {
    const beforeRows = await applicationRows('mentor-b1');
    expect(beforeRows).toHaveLength(1);
    expect(beforeRows[0].status).toBe(5);

    const blocked = await api('mentor-b1')
      .post('/mentor-applications')
      .send({})
      .expect(409);
    const body = blocked.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE);
    expect(body.message).toBe(NOT_SUBMITTABLE_MESSAGE);
    // 无新申请行落库；档案仍是 1（资格门自己拦的）
    expect(await applicationRows('mentor-b1')).toHaveLength(1);
    expect(((await readProfile('mentor-b1')) as MentorProfile).status).toBe(1);

    // 出口有且只有一条：二级学院重审不通过 → 3 → 档案 3 REJECTED
    await api('college-admin-b')
      .post(`/mentor-applications/${b1App1.id.toString()}/college-review`)
      .send({ decision: 'reject', comment: '重审不通过，退回申请人' })
      .expect(200);
    expect((await readApp(b1App1.id)).status).toBe(3);
    expect(((await readProfile('mentor-b1')) as MentorProfile).status).toBe(3);

    const resubmitted = await submitApp('mentor-b1');
    expect(resubmitted.status).toBe(2);
    expect(await applicationRows('mentor-b1')).toHaveLength(2);
    expect(((await readProfile('mentor-b1')) as MentorProfile).status).toBe(1);
  });

  it('补充：错误顺序 404 → 403 → 409——不存在的 :id 先拿 404 / 31104', async () => {
    // 详情：404 先于一切
    await api('sc-admin').get('/mentor-applications/999999').expect(404);
    // 审核入口：对不存在的单既无关也无从越权，先 404
    const review404 = await api('reviewer-wide')
      .post('/mentor-applications/999999/college-review')
      .send({ decision: 'reject', comment: '不存在的单' })
      .expect(404);
    const body = review404.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.MENTOR_APPLICATION_NOT_FOUND);
    expect(body.message).toBe(APPLICATION_NOT_FOUND_MESSAGE);
    // withdraw 同样先 404
    await api('mentor-a2')
      .post('/mentor-applications/999999/withdraw')
      .send({})
      .expect(404);
  });

  it('判据 19：路由面恰好 5 条；docs:gen 85 路径 / 112 操作（不多不少）', () => {
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
    expect(methodsOf('/mentor-applications')).toEqual(['get', 'post']);
    expect(methodsOf('/mentor-applications/{id}')).toEqual(['get']);
    expect(methodsOf('/mentor-applications/{id}/college-review')).toEqual([
      'post',
    ]);
    expect(methodsOf('/mentor-applications/{id}/sc-review')).toEqual(['post']);
    expect(methodsOf('/mentor-applications/{id}/withdraw')).toEqual(['post']);

    // 判据 19 的总数契约（docs:gen 门槛钉同一对数字）。
    // Task 15 加了 POST /mentor-applications/profile-change：+1 路径 +1 操作（41/57 → 42/58）；
    // Task 16+17 的佐证材料面再加 4 路径 / 5 操作（42/58 → 46/63）；
    // Task 18 的后台改档 PUT /mentor/profiles/{id} 再加 1 路径 / 1 操作（46/63 → 47/64）；
    // Task 21 的时段管理 /mentor/slots + /mentor/slots/{id} 再加 2 路径 / 4 操作（47/64 → 49/68）；
    // Task 22 的导师检索 /mentors + /mentors/{id} 再加 2 路径 / 2 操作（49/68 → 51/70）；
    // Task 23 的发起预约 POST /appointments 再加 1 路径 / 1 操作（51/70 → 52/71）；
    // Task 24 的预约处理 confirm / reject / reschedule 再加 3 路径 / 3 操作（52/71 → 55/74）；
    // Task 25 的学生取消 POST /appointments/{id}/cancel 再加 1 路径 / 1 操作（55/74 → 56/75）；
    // Task 26 的指导记录 POST + GET /appointments/{id}/record 再加 1 路径 / 2 操作（56/75 → 57/77）；
    // Task 27 的学生确认记录 / 提异议（confirm-record、dispute，各 1 个 POST）
    // 再加 2 路径 / 2 操作（57/77 → 59/79）；
    // Task 28 的异议复核 POST /appointments/{id}/adjudicate 再加 1 路径 / 1 操作
    // （59/79 → 60/80）；
    // Task 29 的预约材料 / 过程材料再加 4 路径 / 5 操作（60/80 → 64/85）；
    // Task 30 的预约列表 + 详情：`GET /appointments` 与既有 POST 同一条路径
    // （只 +1 操作）、`GET /appointments/{id}` 是新路径（+1 路径 +1 操作）
    // （64/85 → 65/87）；
    // P3 Task 34 的评价再加 2 路径 / 3 操作（`/appointments/{id}/review` 的 post+get、
    // `/mentors/{mentorId}/reviews` 的 get）（65/87 → 67/90）；
    // P3 Task 36 的成果再加 2 路径 / 4 操作（67/90 → 69/94）
    // P4 的统计 / 导出 / 归档：85/112 → 88/118
    // P5 的学期规则 / 消息 / 学生成果：88/118 → 100/133
    const paths = Object.keys(document.paths);
    expect(paths).toHaveLength(100);
    let operations = 0;
    for (const path of paths) {
      operations += methodsOf(path).length;
    }
    expect(operations).toBe(133);
  });

  it('补 P2-A：deptAndChildren 的 college-admin-a 审外院申请 → 403 / 10003，申请行逐字不变', async () => {
    // Task 14 评审 P2-A 的字面组合：角色范围 deptAndChildren + 外院申请 +
    // 审核动作（不是详情）。走真实权限路径，不许超管绕行
    const rows = await applicationRows('mentor-b1');
    const target = rows[rows.length - 1];
    expect(target.status).toBe(2);
    const before = await readApp(target.id);

    const response = await api('college-admin-a')
      .post(`/mentor-applications/${target.id.toString()}/college-review`)
      .send({ decision: 'reject', comment: '外院的单不该我审' })
      .expect(403);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.FORBIDDEN);
    expect(body.message).toBe('无权限');

    // 申请行逐字不变（403 先于一切，一列都没动）
    const after = await readApp(target.id);
    expect(after).toEqual(before);
  });

  it('补 P2-B：reviewer-wide 的列表 / 详情天花板 all 不夹窄——列表出全校、详情看得见外院', async () => {
    // 红线 8 的对偶看门狗：列表 / 详情的天花板被改窄成 'dept' 的话，
    // reviewer-wide（all 角色）就再也出不了 collegeA，这两行会转红
    const list = await api('reviewer-wide')
      .get('/mentor-applications')
      .query({ page: 1, pageSize: 50 })
      .expect(200);
    const listBody = list.body as ResponseEnvelope<MentorApplicationPage>;
    // 此刻库态共 10 条（a1、a2×2、a3、a4、a5、b1×2、b2、b3），全校都要出
    expect(listBody.data.total).toBe(10);
    const applicants = new Set(
      listBody.data.list.map((row) => row.applicantId),
    );
    expect(applicants.has(personId('mentor-a1').toString())).toBe(true);
    expect(applicants.has(personId('mentor-b2').toString())).toBe(true);

    const rows = await applicationRows('mentor-b1');
    const target = rows[rows.length - 1];
    const detail = await api('reviewer-wide')
      .get(`/mentor-applications/${target.id.toString()}`)
      .expect(200);
    const detailData = (
      detail.body as ResponseEnvelope<MentorApplicationResponseDto>
    ).data;
    expect(detailData.applicantId).toBe(personId('mentor-b1').toString());
    expect(detailData.status).toBe(2);
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
