import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type {
  MentorApplication,
  MentorProfile,
  SyncPerson,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { runWithSyncWrite } from '../src/infra/prisma/sync-write-scope';
import { ErrorCode } from '../src/common/constants/error-code';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import type { FileResponseDto } from '../src/modules/file/dto/file-response.dto';
import type { MentorProfileResponseDto } from '../src/modules/mentor/dto/mentor-profile.dto';
import type { MentorApplicationResponseDto } from '../src/modules/mentor-application/dto/mentor-application-response.dto';
import type { ReviewRecord } from '../src/modules/mentor-application/dto/review.dto';
import type { MaterialResponseDto } from '../src/modules/mentor-material/dto/material-response.dto';
import type { PermissionResponseDto } from '../src/modules/permission/dto/permission-response.dto';
import type { RoleResponseDto } from '../src/modules/role/dto/role-response.dto';
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

/**
 * P1 端到端验收 —— **一条流程走到底**（Task 19，裁定 R65）。
 *
 * 这不是 roll-up：既有用例各测各的断面（Task 11 建档 / 13 提交 / 14 审核 /
 * 16-17 材料 / 15 信息修改），**没有一个测这条链**。本文件断言的是
 * **状态在人与人之间交接**——每一步的前置是上一步的后置：
 *
 *   导师填档案 → 提交入驻 → 挂材料 → 二级学院审 → 双创学院审 → 管理员能查到 →
 *   材料能预览下载
 *
 * 正链七步（每个 `it` 断言「这一步真的推进了」，不是只断言 200/201）：
 *   1. `PUT /mentor/profile` → 200，`MentorProfile.status = 0 DRAFT`
 *   2. `POST /mentor-applications` → 201，申请 `type=1/status=2`、snapshot 逐字段一致、
 *      档案 `0 → 1 PENDING`
 *   3. `POST /files`（ownerType=MentorApplication）+ `POST .../materials` → 201
 *   4. college approve → 申请 `status = 4`，档案仍 1
 *   5. sc approve → 申请 `status = 6`，档案 `→ 2 APPROVED`
 *   6. **`GET /mentor-applications/:id`**（钉死，不许二选一）→ 200 看得见；
 *      外院 `dataScope='dept'` 审核者调同一个 `:id` → **403 / 10003**（不是 404）
 *   7. `.../preview` → 200 + inline；`.../download` → 200 + attachment
 *
 * 三条负路径：
 *   N1 退回重改后再提交，流程能重新走（reject → 3 → PUT → 重交 → 两级审到 6）
 *   N2 二级学院管理员越权审双创那一跳 → 403 / 10003，申请仍 4
 *   N3 申请人改档案不影响已提交申请的快照（profile-change，**排在正链第 7 步之后**）
 *
 * N3 的写法（brief §2 第三稿，早稿错了两稿）：`profile-change` 的资格门是
 * `MentorProfile.status = 2`，入驻刚提交（`status=1`）时调会 409 / 31103；
 * 排在正链第 7 步之后，档案已 2 APPROVED、原申请已 6 APPROVED、无在审申请
 * （R58 的 31106 不挡）。它**有请求体**（`UpdateMentorProfileDto`，增量语义），
 * 不是 `submit-onboard` 那条无 body 的写法。
 */

const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

const SYNCED_AT = new Date('2026-10-27T00:00:00.000Z');

describe('P1 端到端流程 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let fileRoot: string;
  let savedFileRoot: string | undefined;

  let adminApi: E2eApi;

  /** 部门树：root「总公司」← collegeA / collegeB */
  const deptIds = new Map<string, bigint>();
  const agents = new Map<string, E2eApi>();
  const people = new Map<string, SyncPerson>();
  const permissionIds = new Map<string, string>();

  /** 正链第 1 步捕获的「提交当时的档案」；第 2 步拿它逐字段比对快照 */
  let profileBeforeSubmit: MentorProfile;
  /** 正链第 2 步落下的入驻申请（N3 的「旧申请」） */
  let onboardApp: MentorApplication;
  /** 正链第 2 步的 snapshot（N3 逐字比对的基准） */
  let onboardSnapshot: Record<string, unknown>;
  /** 正链第 3 步挂上的材料行（第 7 步预览 / 下载） */
  let materialId: bigint;

  beforeAll(async () => {
    fileRoot = await mkdtemp(join(tmpdir(), 'general-back-p1-flow-e2e-'));
    savedFileRoot = process.env.FILE_ROOT;
    process.env.FILE_ROOT = fileRoot;

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

    const admin = await seedSuperAdmin(prisma);
    const adminTokens = await loginAs(app, admin.username, admin.password);
    adminApi = authedAgent(app, adminTokens.accessToken);

    const root = await prisma.client.sysDept.findFirst({
      where: { name: '总公司' },
    });
    if (root === null) {
      throw new Error('seedSuperAdmin 未种出「总公司」部门');
    }
    deptIds.set('root', root.id);
    deptIds.set('collegeA', await createDept('流程学院 A', root.id));
    deptIds.set('collegeB', await createDept('流程学院 B', root.id));

    // 同步层的行只有同步任务能写（SYNC_WRITE_FORBIDDEN）：造数走 runWithSyncWrite
    const orgA = await runWithSyncWrite(() =>
      prisma.client.syncOrgUnit.create({
        data: {
          code: 'ORG-FLOW-A',
          name: '流程学院 A 组织',
          kind: 'college',
          deptId: dept('collegeA'),
          syncedAt: SYNCED_AT,
          createdBy: 0n,
          updatedBy: 0n,
        },
      }),
    );

    // 角色全走真实权限路径（权限码分流，不看角色名）
    const mentorRole = await createRoleWithCodes(
      'P1 流程导师角色',
      'flow_mentor',
      'self',
      [
        'mentor-application:submit',
        // 真实 mentor 角色同时持有 list（seed 里就是这么配的）：列表可读，
        // 详情靠服务层 isApplicant 放行本人。
        'mentor-application:list',
        'mentor:profile',
        'mentor:profile-update',
        'file:create',
      ],
    );
    const collegeRole = await createRoleWithCodes(
      'P1 流程二级学院管理员',
      'flow_college',
      'deptAndChildren',
      ['mentor-application:review-college', 'mentor-application:list'],
    );
    const scRole = await createRoleWithCodes(
      'P1 流程双创管理员',
      'flow_sc',
      'all',
      ['mentor-application:review-sc', 'mentor-application:list'],
    );
    // 外院审核者：dataScope='dept'（仅本院），正链第 6 步的 403 靠它
    const outDeptRole = await createRoleWithCodes(
      'P1 流程外院审核员',
      'flow_out_dept',
      'dept',
      ['mentor-application:list'],
    );

    // 三个导师（username = login，身份链靠自然键），全部挂 collegeA
    for (const login of ['mentor-a', 'mentor-b', 'mentor-c']) {
      const person = await runWithSyncWrite(() =>
        prisma.client.syncPerson.create({
          data: {
            login,
            realName: login,
            personType: 'internalMentor',
            orgUnitId: orgA.id,
            syncedAt: SYNCED_AT,
            createdBy: 0n,
            updatedBy: 0n,
          },
        }),
      );
      people.set(login, person);
      const user = await seedUser(prisma, {
        username: login,
        deptId: dept('collegeA'),
      });
      await linkUserRole(user.userId, BigInt(mentorRole.id));
    }

    // 三个审核者（不需要 SyncPerson：审核走账号 + 权限码 + 数据范围）
    const reviewers: Array<[string, bigint, RoleResponseDto]> = [
      ['college-admin-a', dept('collegeA'), collegeRole],
      ['sc-admin', dept('root'), scRole],
      ['reviewer-out-dept', dept('collegeB'), outDeptRole],
    ];
    for (const [login, deptId, role] of reviewers) {
      const user = await seedUser(prisma, { username: login, deptId });
      await linkUserRole(user.userId, BigInt(role.id));
    }

    for (const login of [
      'mentor-a',
      'mentor-b',
      'mentor-c',
      'college-admin-a',
      'sc-admin',
      'reviewer-out-dept',
    ]) {
      const tokens = await loginAs(app, login, 'Passw0rd!');
      agents.set(login, authedAgent(app, tokens.accessToken));
    }
  });

  afterAll(async () => {
    if (savedFileRoot === undefined) {
      delete process.env.FILE_ROOT;
    } else {
      process.env.FILE_ROOT = savedFileRoot;
    }

    try {
      if (prisma !== undefined) {
        await clearMentorAndSyncTables(prisma);
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
      await rm(fileRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
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

  async function readProfile(login: string): Promise<MentorProfile | null> {
    return prisma.client.mentorProfile.findFirst({
      where: { personId: personId(login) },
    });
  }

  async function requireProfile(login: string): Promise<MentorProfile> {
    const row = await readProfile(login);
    if (row === null) {
      throw new Error(`${login} 还没有档案行`);
    }
    return row;
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

  /** 提交入驻（Task 13 的 POST）：返回落库行（status 恒 2） */
  async function submitOnboard(login: string): Promise<MentorApplication> {
    const response = await api(login)
      .post('/mentor-applications')
      .send({})
      .expect(201);
    const data = (
      response.body as ResponseEnvelope<MentorApplicationResponseDto>
    ).data;
    expect(data.type).toBe(1);
    expect(data.status).toBe(2);
    const rows = await applicationRows(login);
    return rows[rows.length - 1];
  }

  async function collegeReview(
    login: string,
    appId: bigint,
    decision: 'approve' | 'reject',
    comment: string,
  ): Promise<MentorApplicationResponseDto> {
    const response = await api(login)
      .post(`/mentor-applications/${appId.toString()}/college-review`)
      .send({ decision, comment })
      .expect(200);
    return (response.body as ResponseEnvelope<MentorApplicationResponseDto>)
      .data;
  }

  async function scReview(
    login: string,
    appId: bigint,
    decision: 'approve' | 'reject',
    comment: string,
  ): Promise<MentorApplicationResponseDto> {
    const response = await api(login)
      .post(`/mentor-applications/${appId.toString()}/sc-review`)
      .send({ decision, comment })
      .expect(200);
    return (response.body as ResponseEnvelope<MentorApplicationResponseDto>)
      .data;
  }

  // ── 正链 ──────────────────────────────────────────────────────────

  it('正链 1：导师填档案 PUT /mentor/profile → 200，库里 MentorProfile.status = 0 DRAFT', async () => {
    const response = await api('mentor-a')
      .put('/mentor/profile')
      .send(fullDraft())
      .expect(200);
    const data = (response.body as ResponseEnvelope<MentorProfileResponseDto>)
      .data;
    expect(data.status).toBe(0);
    expect(data.summary).toBe('个人简介一版');
    expect(data.mentorType).toBe('internal');
    // R49：内校导师的合作单位 / 社会任职落库置 null
    expect(data.affiliateOrg).toBeNull();
    expect(data.socialRoles).toBeNull();

    profileBeforeSubmit = await requireProfile('mentor-a');
    expect(profileBeforeSubmit.status).toBe(0);
    expect(profileBeforeSubmit.personId).toBe(personId('mentor-a'));
  });

  it('正链 2：提交入驻 → 201，申请 type=1/status=2、snapshot 与档案逐字段一致，档案 0 → 1 PENDING', async () => {
    const response = await api('mentor-a')
      .post('/mentor-applications')
      .send({})
      .expect(201);
    const data = (
      response.body as ResponseEnvelope<MentorApplicationResponseDto>
    ).data;
    expect(data.type).toBe(1);
    expect(data.status).toBe(2);
    expect(data.applicantId).toBe(personId('mentor-a').toString());
    expect(data.submittedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );

    const rows = await applicationRows('mentor-a');
    expect(rows).toHaveLength(1);
    onboardApp = rows[0];
    expect(onboardApp.type).toBe(1);
    expect(onboardApp.status).toBe(2);
    expect(onboardApp.applicantId).toBe(personId('mentor-a'));
    expect(onboardApp.profileId).toBe(profileBeforeSubmit.id);
    // 快照逐字段一致（含推导的 mentorType；内校两列已是 null）
    expect(onboardApp.snapshot).toEqual(
      expectedDraft(profileBeforeSubmit, 'internal'),
    );
    onboardSnapshot = onboardApp.snapshot as Record<string, unknown>;

    // R52：提交与档案推进同事务，0 → 1 PENDING
    expect(profileBeforeSubmit.status).toBe(0);
    expect((await requireProfile('mentor-a')).status).toBe(1);
  });

  it('正链 3：上传文件（ownerType=MentorApplication）后挂材料 → 201，库里落 1 行且归属对', async () => {
    const upload = await api('mentor-a')
      .post('/files')
      .field('ownerType', 'MentorApplication')
      .field('ownerId', onboardApp.id.toString())
      .attach('files', PDF, {
        filename: '职称证书.pdf',
        contentType: 'application/octet-stream',
      })
      .expect(201);
    const file = (upload.body as ResponseEnvelope<FileResponseDto[]>).data[0];
    expect(file.ownerType).toBe('MentorApplication');
    expect(file.ownerId).toBe(onboardApp.id.toString());
    expect(file.mimeType).toBe('application/pdf');

    const response = await api('mentor-a')
      .post(`/mentor-applications/${onboardApp.id.toString()}/materials`)
      .send({ fileId: file.id, kind: 1 })
      .expect(201);
    const material = (response.body as ResponseEnvelope<MaterialResponseDto>)
      .data;
    materialId = BigInt(material.id);
    expect(material.applicationId).toBe(onboardApp.id.toString());
    expect(material.fileId).toBe(file.id);
    expect(material.kind).toBe(1);
    expect(material.originName).toBe('职称证书.pdf');

    const rows = await prisma.client.mentorApplicationMaterial.findMany({
      where: { applicationId: onboardApp.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].fileId).toBe(BigInt(file.id));
    expect(rows[0].kind).toBe(1);
  });

  it('正链 4：二级学院审（通过）→ 200，申请 status = 4，档案仍 1 PENDING', async () => {
    const data = await collegeReview(
      'college-admin-a',
      onboardApp.id,
      'approve',
      '材料齐全，同意',
    );
    expect(data.status).toBe(4);
    expect(data.collegeReview?.decision).toBe('approve');
    expect(data.collegeReview?.comment).toBe('材料齐全，同意');
    expect(data.scReview).toBeNull();

    const row = await readApp(onboardApp.id);
    expect(row.status).toBe(4);
    const record = row.collegeReview as unknown as ReviewRecord;
    expect(record.decision).toBe('approve');
    expect(record.comment).toBe('材料齐全，同意');
    // 落点 4（还在审）档案不动
    expect((await requireProfile('mentor-a')).status).toBe(1);
  });

  it('正链 5：双创学院审（通过）→ 200，申请 status = 6，MentorProfile.status → 2 APPROVED', async () => {
    const data = await scReview(
      'sc-admin',
      onboardApp.id,
      'approve',
      '同意入驻',
    );
    expect(data.status).toBe(6);
    expect(data.scReview?.decision).toBe('approve');
    expect(data.scReview?.comment).toBe('同意入驻');

    const row = await readApp(onboardApp.id);
    expect(row.status).toBe(6);
    const record = row.scReview as unknown as ReviewRecord;
    expect(record.decision).toBe('approve');
    // 副作用表：落点 6 → 档案 2 APPROVED
    expect((await requireProfile('mentor-a')).status).toBe(2);
  });

  it('正链 6：持 list 的审核者 GET /mentor-applications/:id → 200 看得见；外院 dept 审核者同一 :id → 403 / 10003', async () => {
    // 钉死详情入口（不是 GET /users 之类）：查得到这条申请与它的 snapshot
    const response = await api('college-admin-a')
      .get(`/mentor-applications/${onboardApp.id.toString()}`)
      .expect(200);
    const data = (
      response.body as ResponseEnvelope<MentorApplicationResponseDto>
    ).data;
    expect(data.id).toBe(onboardApp.id.toString());
    expect(data.status).toBe(6);
    expect(data.applicantId).toBe(personId('mentor-a').toString());
    expect(data.snapshot).toEqual(onboardSnapshot);

    // 安全条款：外院 dataScope='dept' 的审核者看不到别院的单——
    // assertDeptVisible 挡下是 403 / 10003（不是 404）
    const forbidden = await api('reviewer-out-dept')
      .get(`/mentor-applications/${onboardApp.id.toString()}`)
      .expect(403);
    const body = forbidden.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.FORBIDDEN);
    expect(body.message).toBe('无权限');
    expect(body.data).toBeNull();
  });

  it('申请人本人 GET /mentor-applications/:id → 200（self 范围可读自己的申请）', async () => {
    const response = await api('mentor-a')
      .get(`/mentor-applications/${onboardApp.id.toString()}`)
      .expect(200);
    const data = (
      response.body as ResponseEnvelope<MentorApplicationResponseDto>
    ).data;
    expect(data.id).toBe(onboardApp.id.toString());
    expect(data.applicantId).toBe(personId('mentor-a').toString());
  });

  it('GET /auth/profile 返回 personType / mentorType', async () => {
    const response = await api('mentor-a').get('/auth/profile').expect(200);
    const data = (
      response.body as ResponseEnvelope<{
        user: { personType?: string | null; mentorType?: string | null };
      }>
    ).data;
    expect(data.user.personType).toBe('internalMentor');
    expect(data.user.mentorType).toBe('internal');
  });

  it('正链 7：材料能预览下载 → preview 200 + inline，download 200 + attachment，字节一致', async () => {
    const base = `/mentor-applications/${onboardApp.id.toString()}/materials/${materialId.toString()}`;

    const preview = await api('college-admin-a')
      .get(`${base}/preview`)
      .expect(200);
    expect(preview.headers['content-disposition']).toContain('inline');
    expect(preview.headers['content-type']).toBe('application/pdf');
    expect(Buffer.isBuffer(preview.body)).toBe(true);
    expect(Buffer.compare(preview.body as Buffer, PDF)).toBe(0);

    const download = await api('college-admin-a')
      .get(`${base}/download`)
      .expect(200);
    const disposition = download.headers['content-disposition'];
    expect(disposition).toContain('attachment');
    // 原名「职称证书.pdf」的 RFC 5987 编码
    expect(disposition).toContain('%E8%81%8C%E7%A7%B0%E8%AF%81%E4%B9%A6.pdf');
    expect(download.headers['content-type']).toBe('application/octet-stream');
    expect(Buffer.compare(download.body as Buffer, PDF)).toBe(0);
  });

  // ── 三条负路径 ────────────────────────────────────────────────────

  it('N1：退回重改后再提交，流程能重新走——reject→3/档案3 → PUT 200 → 重交 201/档案1 → 两级审到 6/档案2', async () => {
    await api('mentor-b')
      .put('/mentor/profile')
      .send(fullDraft({ summary: 'B 的简介一版' }))
      .expect(200);
    const first = await submitOnboard('mentor-b');

    // 二级学院退回 → 申请 3、档案 3 REJECTED
    const rejected = await collegeReview(
      'college-admin-a',
      first.id,
      'reject',
      '材料不全，退回补充',
    );
    expect(rejected.status).toBe(3);
    expect((await readApp(first.id)).status).toBe(3);
    expect((await requireProfile('mentor-b')).status).toBe(3);

    // R55 的门放行 3：退回后能改草稿
    const draftBeforePut = await requireProfile('mentor-b');
    await api('mentor-b')
      .put('/mentor/profile')
      .send(fullDraft({ summary: 'B 的简介二版' }))
      .expect(200);
    const afterPut = await requireProfile('mentor-b');
    expect(afterPut.summary).toBe('B 的简介二版');
    expect(afterPut.status).toBe(3); // PUT 不改 status

    // 重新提交 → 新申请 status=2，档案 → 1 PENDING
    const second = await submitOnboard('mentor-b');
    expect(second.id).not.toBe(first.id);
    expect(second.snapshot).toMatchObject({ summary: 'B 的简介二版' });
    const rows = await applicationRows('mentor-b');
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].status).toBe(3);
    // 旧申请的快照逐字不动
    expect(rows[0].snapshot).toEqual(expectedDraft(draftBeforePut, 'internal'));
    expect((await requireProfile('mentor-b')).status).toBe(1);

    // 再走两级审到 6、档案 → 2
    const college = await collegeReview(
      'college-admin-a',
      second.id,
      'approve',
      '补齐材料，同意',
    );
    expect(college.status).toBe(4);
    expect((await requireProfile('mentor-b')).status).toBe(1);
    const sc = await scReview('sc-admin', second.id, 'approve', '同意入驻');
    expect(sc.status).toBe(6);
    expect((await readApp(second.id)).status).toBe(6);
    expect((await requireProfile('mentor-b')).status).toBe(2);
  });

  it('N2：二级学院管理员越权审双创那一跳 → 403 / 10003，消息含 review-sc，申请仍是 4', async () => {
    await api('mentor-c')
      .put('/mentor/profile')
      .send(fullDraft({ summary: 'C 的简介' }))
      .expect(200);
    const submitted = await submitOnboard('mentor-c');

    const college = await collegeReview(
      'college-admin-a',
      submitted.id,
      'approve',
      '本院通过',
    );
    expect(college.status).toBe(4);
    expect((await readApp(submitted.id)).status).toBe(4);

    // 持 review-college 的人没有 review-sc：权限门先挡，403 且点名缺的码
    const response = await api('college-admin-a')
      .post(`/mentor-applications/${submitted.id.toString()}/sc-review`)
      .send({ decision: 'approve', comment: '越权想审双创的活' })
      .expect(403);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.FORBIDDEN);
    expect(body.message).toContain('mentor-application:review-sc');
    // 申请一个字没动，仍停在 4
    expect((await readApp(submitted.id)).status).toBe(4);
  });

  it('N3：申请人改档案不影响已提交申请的快照——profile-change → 201，原入驻申请 snapshot 逐字不变', async () => {
    // 前置：正链第 7 步之后，档案 2 APPROVED、原入驻申请 6 APPROVED、无在审申请
    expect((await requireProfile('mentor-a')).status).toBe(2);
    expect((await readApp(onboardApp.id)).status).toBe(6);

    const oldRowBefore = await readApp(onboardApp.id);
    const oldSnapshotBefore = JSON.stringify(oldRowBefore.snapshot);

    // profile-change 有请求体（UpdateMentorProfileDto，增量语义），不是无 body 的提交
    const response = await api('mentor-a')
      .post('/mentor-applications/profile-change')
      .send({ summary: '入驻后新简介' })
      .expect(201);
    const data = (
      response.body as ResponseEnvelope<MentorApplicationResponseDto>
    ).data;
    expect(data.type).toBe(2);
    expect(data.status).toBe(2);
    expect(data.snapshot.summary).toBe('入驻后新简介');

    // 提案落在**新申请**上（R67 合并到当前档案），旧入驻申请的行一个字节没动
    const rows = await applicationRows('mentor-a');
    expect(rows).toHaveLength(2);
    const proposal = rows.find((row) => row.type === 2);
    if (proposal === undefined) {
      throw new Error('没有落 type=2 的提案');
    }
    expect(proposal.id).not.toBe(onboardApp.id);
    expect(proposal.status).toBe(2);
    const currentProfile = await requireProfile('mentor-a');
    const expectedProposal = expectedDraft(currentProfile, 'internal');
    expectedProposal.summary = '入驻后新简介';
    expect(proposal.snapshot).toEqual(expectedProposal);

    const oldRowAfter = await readApp(onboardApp.id);
    expect(oldRowAfter).toEqual(oldRowBefore);
    expect(JSON.stringify(oldRowAfter.snapshot)).toBe(oldSnapshotBefore);
    expect(oldRowAfter.snapshot).toEqual(onboardSnapshot);
    expect(oldRowAfter.status).toBe(6);

    // 提案尚未生效：档案行仍停在原值（type=2 的任何流转都不碰 MentorProfile）
    expect(currentProfile.status).toBe(2);
    expect(currentProfile.summary).toBe('个人简介一版');
  });
});

/**
 * 清残留。走裸 SQL（照 mentor-material.e2e-spec.ts 的同名函数）：清库是测试的
 * 运维动作，不是业务写入。顺序按外键拓扑序——material 先于 application，
 * 再 profile，再 sync_person / sync_org_unit。
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
