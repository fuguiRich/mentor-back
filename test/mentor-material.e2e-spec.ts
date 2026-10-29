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
import { buildDocument, configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { runWithSyncWrite } from '../src/infra/prisma/sync-write-scope';
import { ErrorCode } from '../src/common/constants/error-code';
import type { FieldErrorDto } from '../src/common/dto/field-error.dto';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import type { FileResponseDto } from '../src/modules/file/dto/file-response.dto';
import type { PermissionResponseDto } from '../src/modules/permission/dto/permission-response.dto';
import type { RoleResponseDto } from '../src/modules/role/dto/role-response.dto';
import type {
  MaterialListResponseDto,
  MaterialResponseDto,
} from '../src/modules/mentor-material/dto/material-response.dto';
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

/** 合法 PDF 头（魔数只看签名） */
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
/** 合法 PNG 头（8 字节签名） */
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

const SYNCED_AT = new Date('2026-10-27T00:00:00.000Z');

/**
 * 导师佐证材料 (e2e) —— brief §5 的 20 条判据。
 *
 * 判据 20（docs:gen 47 路径 / 64 操作）由门槛命令核，不在这里钉总数（既有
 * e2e 的惯例：总数会随业务接口长，钉死等于「一加接口就红」）。这里钉的是
 * 材料面的**路由形状**：4 条路径 / 5 个操作，一条不多一条不少。
 *
 * 用例执行顺序就是判据编号顺序（共享库态、maxWorkers:1 串行）：判据 11 依赖
 * 判据 1-3 挂好的三行；判据 16 摘掉判据 1 那一行，判据 17 再挂回来，判据 18
 * 正好拿那条已软删的行验 404。
 */
describe('导师佐证材料 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let root: string;
  let savedRoot: string | undefined;

  let adminApi: E2eApi;
  const agents = new Map<string, E2eApi>();
  const permissionIds = new Map<string, string>();
  const deptIds = new Map<string, bigint>();
  const people = new Map<string, SyncPerson>();
  const profiles = new Map<string, MentorProfile>();
  const apps = new Map<string, MentorApplication>();
  const files = new Map<string, FileResponseDto>();
  /** 判据 9 用：status=4..7 的申请上各有一行材料 */
  const frozenMaterials = new Map<number, bigint>();
  /** 判据 1 挂出的那一行（判据 14/15 预览下载、判据 16 摘除、判据 18 已软删） */
  let firstMaterialId: bigint;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'general-back-material-e2e-'));
    savedRoot = process.env.FILE_ROOT;
    process.env.FILE_ROOT = root;

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

    const rootDept = await prisma.client.sysDept.findFirst({
      where: { name: '总公司' },
    });
    if (rootDept === null) {
      throw new Error('seedSuperAdmin 未种出「总公司」部门');
    }
    deptIds.set('root', rootDept.id);
    deptIds.set('A', await createDept('学院 A', rootDept.id));
    deptIds.set('B', await createDept('学院 B', rootDept.id));

    // 同步层的行只有同步任务能写（SYNC_WRITE_FORBIDDEN）：测试造数走 runWithSyncWrite
    const orgA = await createOrg('ORG-MAT-A', '学院 A 组织', dept('A'));
    const orgB = await createOrg('ORG-MAT-B', '学院 B 组织', dept('B'));

    const identities: Array<[string, string, bigint]> = [
      ['mentor-a', 'internalMentor', orgA],
      ['mentor-b', 'internalMentor', orgB],
    ];
    for (const [login, personType, orgUnitId] of identities) {
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
      people.set(login, person);
    }

    const mentorRole = await createRoleWithCodes(
      '材料导师角色',
      'mat_mentor',
      'self',
      ['mentor-application:submit', 'mentor-application:list', 'file:create'],
    );
    const collegeRole = await createRoleWithCodes(
      '材料院级审核角色',
      'mat_college',
      'deptAndChildren',
      ['mentor-application:list', 'file:list'],
    );
    const opsRole = await createRoleWithCodes(
      '材料运维角色',
      'mat_ops',
      'all',
      ['file:list'],
    );

    // username = login：身份链（SysUser.username → SyncPerson.login）靠自然键，
    // 导师的账号名必须与 SyncPerson.login 逐字相同
    const users: Array<[string, bigint, RoleResponseDto]> = [
      ['mentor-a', dept('A'), mentorRole],
      ['mentor-b', dept('B'), mentorRole],
      ['college-admin-a', dept('A'), collegeRole],
      ['ops-admin', dept('root'), opsRole],
    ];
    for (const [username, deptId, role] of users) {
      const user = await seedUser(prisma, { username, deptId });
      await linkUserRole(user.userId, BigInt(role.id));
    }

    for (const login of [
      'mentor-a',
      'mentor-b',
      'college-admin-a',
      'ops-admin',
    ]) {
      const tokens = await loginAs(app, login, 'Passw0rd!');
      agents.set(login, authedAgent(app, tokens.accessToken));
    }

    for (const login of ['mentor-a', 'mentor-b']) {
      const profile = await prisma.client.mentorProfile.create({
        data: {
          personId: personId(login),
          researchFields: [],
          status: 1,
          createdBy: 0n,
          updatedBy: 0n,
        },
      });
      profiles.set(login, profile);
    }

    apps.set('A1', await createApplication('mentor-a', 2));
    apps.set('A3', await createApplication('mentor-a', 3));
    for (const status of [4, 5, 6, 7]) {
      apps.set(`A${status}`, await createApplication('mentor-a', status));
    }
    apps.set('B', await createApplication('mentor-b', 2));

    // 文件全部先上传好；归属由上传方给（ownerType / ownerId 成对）
    files.set('A1', await upload('mentor-a', '职称证书.pdf', PDF, 'A1'));
    files.set('A2', await upload('mentor-a', '行业资质.png', PNG, 'A1'));
    files.set('A3', await upload('mentor-a', '其他.png', PNG, 'A1'));
    files.set('A4', await upload('mentor-a', '待挂.png', PNG, 'A1'));
    files.set('A3app', await upload('mentor-a', '退回可挂.png', PNG, 'A3'));
    files.set('B1', await upload('mentor-b', '别人的.png', PNG, 'B'));
    files.set('noOwner', await upload('mentor-a', '无归属.png', PNG));

    // B 的申请上挂一行材料：判据 12 / 13 要拿它验越权读
    const attachedB = await api('mentor-b')
      .post(`/mentor-applications/${appId('B')}/materials`)
      .send({ fileId: files.get('B1')?.id, kind: 1 })
      .expect(201);
    expect(
      (attachedB.body as ResponseEnvelope<MaterialResponseDto>).data.id,
    ).toMatch(/^\d+$/);

    // status=4..7 的申请上各造一行材料：判据 9 的「摘」要验 409 且不删
    for (const status of [4, 5, 6, 7]) {
      const row = await prisma.client.mentorApplicationMaterial.create({
        data: {
          applicationId: appId(`A${status}`),
          kind: 1,
          fileId: BigInt(files.get('A4')?.id ?? '0'),
          createdBy: 0n,
          updatedBy: 0n,
        },
      });
      frozenMaterials.set(status, row.id);
    }
  });

  afterAll(async () => {
    if (savedRoot === undefined) delete process.env.FILE_ROOT;
    else process.env.FILE_ROOT = savedRoot;

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
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
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

  function appId(key: string): bigint {
    const row = apps.get(key);
    if (row === undefined) {
      throw new Error(`没有申请 ${key}`);
    }
    return row.id;
  }

  function personId(login: string): bigint {
    const person = people.get(login);
    if (person === undefined) {
      throw new Error(`没有 ${login} 的 SyncPerson`);
    }
    return person.id;
  }

  function fileId(key: string): string {
    const file = files.get(key);
    if (file === undefined) {
      throw new Error(`没有文件 ${key}`);
    }
    return file.id;
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

  async function createApplication(
    login: string,
    status: number,
  ): Promise<MentorApplication> {
    const profile = profiles.get(login);
    if (profile === undefined) {
      throw new Error(`没有 ${login} 的导师档案`);
    }
    return prisma.client.mentorApplication.create({
      data: {
        type: 1,
        applicantId: personId(login),
        profileId: profile.id,
        snapshot: {},
        status,
        submittedAt: new Date('2026-10-28T03:00:00.000Z'),
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

  /**
   * 上传一个文件。owner 给了就带成对的 ownerType / ownerId——
   * 材料面依赖文件归属，归属不符必须落 404 / 28101。
   */
  async function upload(
    login: string,
    name: string,
    content: Buffer,
    owner?: string,
  ): Promise<FileResponseDto> {
    let req = api(login).post('/files').attach('files', content, {
      filename: name,
      contentType: 'application/octet-stream',
    });
    if (owner !== undefined) {
      req = req
        .field('ownerType', 'MentorApplication')
        .field('ownerId', appId(owner).toString());
    }
    const response = await req.expect(201);
    return (response.body as ResponseEnvelope<FileResponseDto[]>).data[0];
  }

  /** 某申请下未删材料的行数（Prisma 直查，比断言列表层更硬） */
  async function materialCount(key: string): Promise<number> {
    return prisma.client.mentorApplicationMaterial.count({
      where: { applicationId: appId(key) },
    });
  }

  async function errorBody(
    login: string,
    key: string,
    body: Record<string, unknown>,
  ): Promise<{
    status: number;
    body: ResponseEnvelope<null>;
  }> {
    const response = await api(login)
      .post(`/mentor-applications/${appId(key)}/materials`)
      .send(body);
    return {
      status: response.status,
      body: response.body as ResponseEnvelope<null>,
    };
  }

  // ── 判据 1 ────────────────────────────────────────────────────────

  it('判据 1：上传带 ownerType=MentorApplication + ownerId=申请 id 的文件，挂接 → 201，库里 1 行且字段对', async () => {
    const response = await api('mentor-a')
      .post(`/mentor-applications/${appId('A1')}/materials`)
      .send({ fileId: fileId('A1'), kind: 1 })
      .expect(201);
    const data = (response.body as ResponseEnvelope<MaterialResponseDto>).data;
    firstMaterialId = BigInt(data.id);

    expect(data).toMatchObject({
      applicationId: appId('A1').toString(),
      fileId: fileId('A1'),
      kind: 1,
      originName: '职称证书.pdf',
      mimeType: 'application/pdf',
      size: PDF.length,
    });

    const rows = await prisma.client.mentorApplicationMaterial.findMany({
      where: { applicationId: appId('A1') },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      applicationId: appId('A1'),
      fileId: BigInt(fileId('A1')),
      kind: 1,
    });
  });

  // ── 判据 2 ────────────────────────────────────────────────────────

  it('判据 2：kind 传 1 / 2 / 3 三分支 → 各 201', async () => {
    // kind=1 已由判据 1 覆盖；这里补 2 / 3
    for (const [key, kind] of [
      ['A2', 2],
      ['A3', 3],
    ] as const) {
      const response = await api('mentor-a')
        .post(`/mentor-applications/${appId('A1')}/materials`)
        .send({ fileId: fileId(key), kind })
        .expect(201);
      expect(
        (response.body as ResponseEnvelope<MaterialResponseDto>).data.kind,
      ).toBe(kind);
    }
    expect(await materialCount('A1')).toBe(3);
  });

  // ── 判据 3 ────────────────────────────────────────────────────────

  it("判据 3：kind 传 0 / 4 / 'x' → 各 400 / 10001，data.fields 点名 kind，无行落库", async () => {
    for (const kind of [0, 4, 'x']) {
      const response = await api('mentor-a')
        .post(`/mentor-applications/${appId('A1')}/materials`)
        .send({ fileId: fileId('A4'), kind })
        .expect(400);
      const body = response.body as ResponseEnvelope<{
        fields: FieldErrorDto[];
      }>;
      expect(body.code).toBe(ErrorCode.PARAM_INVALID);
      expect(body.data.fields.some((f) => f.field === 'kind')).toBe(true);
    }
    expect(await materialCount('A1')).toBe(3);
  });

  // ── 判据 4 ────────────────────────────────────────────────────────

  it('判据 4：越权①——申请人 A 挂到 B 的申请 → 403 / 10003（不是 404），无行落库', async () => {
    const response = await api('mentor-a')
      .post(`/mentor-applications/${appId('B')}/materials`)
      .send({ fileId: fileId('B1'), kind: 1 })
      .expect(403);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.FORBIDDEN);
    expect(body.message).toBe('无权限');
    // B 的申请下只有 beforeAll 挂的那一行
    expect(await materialCount('B')).toBe(1);
  });

  // ── 判据 5 / 6 / 7 ────────────────────────────────────────────────

  it('判据 5：把别的申请的文件挂到本申请 → 404 / 28101（归属不符），无行落库', async () => {
    const response = await api('mentor-a')
      .post(`/mentor-applications/${appId('A1')}/materials`)
      .send({ fileId: fileId('B1'), kind: 1 })
      .expect(404);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.FILE_NOT_FOUND);
    expect(body.message).toBe('文件不存在');
    expect(await materialCount('A1')).toBe(3);
  });

  it('判据 6：把无归属的文件挂到本申请 → 404 / 28101（fail-closed），无行落库', async () => {
    const response = await api('mentor-a')
      .post(`/mentor-applications/${appId('A1')}/materials`)
      .send({ fileId: fileId('noOwner'), kind: 1 })
      .expect(404);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.FILE_NOT_FOUND);
    expect(body.message).toBe('文件不存在');
    expect(await materialCount('A1')).toBe(3);
  });

  it('判据 7：无归属 / 归属不符 / 文件不存在 三者响应码与文案逐字相同', async () => {
    const missing = await errorBody('mentor-a', 'A1', {
      fileId: '999999',
      kind: 1,
    });
    const noOwner = await errorBody('mentor-a', 'A1', {
      fileId: fileId('noOwner'),
      kind: 1,
    });
    const wrongOwner = await errorBody('mentor-a', 'A1', {
      fileId: fileId('B1'),
      kind: 1,
    });

    for (const result of [missing, noOwner, wrongOwner]) {
      expect(result.status).toBe(404);
      expect(result.body.code).toBe(ErrorCode.FILE_NOT_FOUND);
      expect(result.body.message).toBe('文件不存在');
    }
    // 三条对拍：码、文案、data 一个字都不差（traceId 每次请求不同，不参与对拍）
    for (const other of [noOwner.body, wrongOwner.body]) {
      expect(other.code).toBe(missing.body.code);
      expect(other.message).toBe(missing.body.message);
      expect(other.data).toEqual(missing.body.data);
    }
    expect(await materialCount('A1')).toBe(3);
  });

  // ── 判据 8 ────────────────────────────────────────────────────────

  it('判据 8：同一 fileId 挂两次 → 第二次 409 / 10006', async () => {
    const response = await api('mentor-a')
      .post(`/mentor-applications/${appId('A1')}/materials`)
      .send({ fileId: fileId('A1'), kind: 1 })
      .expect(409);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.CONFLICT);
    expect(body.message).toBe('同一文件不能重复挂到同一申请');
    expect(await materialCount('A1')).toBe(3);
  });

  // ── 判据 9 ────────────────────────────────────────────────────────

  it('判据 9：status=4 / 5 / 6 / 7 时挂或摘 → 各 409 / 31105，无行落库 / 不删', async () => {
    for (const status of [4, 5, 6, 7]) {
      const key = `A${status}`;

      // 挂
      const attach = await api('mentor-a')
        .post(`/mentor-applications/${appId(key)}/materials`)
        .send({ fileId: fileId('A4'), kind: 1 })
        .expect(409);
      const attachBody = attach.body as ResponseEnvelope<null>;
      expect(attachBody.code).toBe(
        ErrorCode.MENTOR_APPLICATION_TRANSITION_INVALID,
      );
      expect(attachBody.message).toBe('当前状态不允许该操作');
      expect(await materialCount(key)).toBe(1); // 只有 beforeAll 造的那一行

      // 摘
      const materialId = frozenMaterials.get(status);
      if (materialId === undefined) {
        throw new Error(`没有 status=${status} 的材料行`);
      }
      const remove = await api('mentor-a')
        .delete(
          `/mentor-applications/${appId(key)}/materials/${materialId.toString()}`,
        )
        .expect(409);
      const removeBody = remove.body as ResponseEnvelope<null>;
      expect(removeBody.code).toBe(
        ErrorCode.MENTOR_APPLICATION_TRANSITION_INVALID,
      );
      expect(removeBody.message).toBe('当前状态不允许该操作');

      const row =
        await prisma.includingDeleted.mentorApplicationMaterial.findFirst({
          where: { id: materialId },
        });
      expect(row?.deletedAt).toBeNull();
    }
  });

  // ── 判据 10 ───────────────────────────────────────────────────────

  it('判据 10：status=2 / 3 时挂 → 各 201（2 由判据 1 覆盖，这里验 3）', async () => {
    const response = await api('mentor-a')
      .post(`/mentor-applications/${appId('A3')}/materials`)
      .send({ fileId: fileId('A3app'), kind: 2 })
      .expect(201);
    expect(
      (response.body as ResponseEnvelope<MaterialResponseDto>).data.kind,
    ).toBe(2);
    expect(await materialCount('A3')).toBe(1);
  });

  // ── 判据 11 ───────────────────────────────────────────────────────

  it('判据 11：申请人的列表出自己的全部材料（kind / fileId / 文件名 / 大小）→ 200，条数对', async () => {
    const response = await api('mentor-a')
      .get(`/mentor-applications/${appId('A1')}/materials`)
      .expect(200);
    const body = response.body as ResponseEnvelope<MaterialListResponseDto>;
    expect(body.code).toBe(0);
    expect(body.data.total).toBe(3);
    expect(body.data.page).toBe(1);
    expect(body.data.pageSize).toBe(3);

    const byFile = new Map(
      body.data.list.map((item) => [item.fileId, item] as const),
    );
    expect(byFile.get(fileId('A1'))).toMatchObject({
      kind: 1,
      originName: '职称证书.pdf',
      mimeType: 'application/pdf',
      size: PDF.length,
    });
    expect(byFile.get(fileId('A2'))).toMatchObject({
      kind: 2,
      originName: '行业资质.png',
      mimeType: 'image/png',
      size: PNG.length,
    });
    expect(byFile.get(fileId('A3'))).toMatchObject({
      kind: 3,
      originName: '其他.png',
      mimeType: 'image/png',
      size: PNG.length,
    });
  });

  // ── 判据 12 / 13 ──────────────────────────────────────────────────

  it('判据 12：越权②——A 读 B 的申请的材料列表 → 403 / 10003', async () => {
    const response = await api('mentor-a')
      .get(`/mentor-applications/${appId('B')}/materials`)
      .expect(403);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.FORBIDDEN);
    expect(body.message).toBe('无权限');
  });

  it('判据 13：越权③——A 预览 / 下载 B 的申请的材料 → 各 403 / 10003（不是 200，不是 404）', async () => {
    const material = await prisma.client.mentorApplicationMaterial.findFirst({
      where: { applicationId: appId('B') },
    });
    if (material === null) {
      throw new Error('B 的申请下没有材料行');
    }

    for (const suffix of ['preview', 'download']) {
      const response = await api('mentor-a')
        .get(
          `/mentor-applications/${appId('B')}/materials/${material.id.toString()}/${suffix}`,
        )
        .expect(403);
      const body = response.body as ResponseEnvelope<null>;
      expect(body.code).toBe(ErrorCode.FORBIDDEN);
      expect(body.message).toBe('无权限');
    }
  });

  // ── 判据 14 / 15 ──────────────────────────────────────────────────

  it('判据 14：审核者预览 PDF 材料 → 200，Content-Disposition: inline，Content-Type: application/pdf，字节流非 JSON', async () => {
    const response = await api('college-admin-a')
      .get(
        `/mentor-applications/${appId('A1')}/materials/${firstMaterialId.toString()}/preview`,
      )
      .expect(200);

    expect(response.headers['content-disposition']).toContain('inline');
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(Buffer.isBuffer(response.body)).toBe(true);
    expect(Buffer.compare(response.body as Buffer, PDF)).toBe(0);
  });

  it('判据 15：审核者下载 → 200，Content-Disposition: attachment，文件名 = 上传时原名', async () => {
    const response = await api('college-admin-a')
      .get(
        `/mentor-applications/${appId('A1')}/materials/${firstMaterialId.toString()}/download`,
      )
      .expect(200);

    const disposition = response.headers['content-disposition'];
    expect(disposition).toContain('attachment');
    expect(disposition).toContain("filename*=UTF-8''");
    // 原名「职称证书.pdf」的 RFC 5987 编码
    expect(disposition).toContain('%E8%81%8C%E7%A7%B0%E8%AF%81%E4%B9%A6.pdf');
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(Buffer.compare(response.body as Buffer, PDF)).toBe(0);
  });

  // ── 判据 16 ───────────────────────────────────────────────────────

  it('判据 16：DELETE 后列表不再出它；SysFile 行仍在（软删生效、文件不丢）', async () => {
    await api('mentor-a')
      .delete(
        `/mentor-applications/${appId('A1')}/materials/${firstMaterialId.toString()}`,
      )
      .expect(204);

    const list = await api('mentor-a')
      .get(`/mentor-applications/${appId('A1')}/materials`)
      .expect(200);
    const body = list.body as ResponseEnvelope<MaterialListResponseDto>;
    expect(body.data.total).toBe(2);
    expect(body.data.list.map((item) => item.fileId)).not.toContain(
      fileId('A1'),
    );

    // 软删：材料行还在，只是打了 deletedAt / deletedBy
    const row =
      await prisma.includingDeleted.mentorApplicationMaterial.findFirst({
        where: { id: firstMaterialId },
      });
    expect(row).not.toBeNull();
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.deletedBy).not.toBeNull();

    // SysFile 行原样在（没被连带删）
    const file = await prisma.client.sysFile.findFirst({
      where: { id: BigInt(fileId('A1')) },
    });
    expect(file).not.toBeNull();
    expect(file?.deletedAt).toBeNull();
  });

  // ── 判据 17 ───────────────────────────────────────────────────────

  it('判据 17：摘掉后再挂同一 fileId → 201（唯一性按未删行算）', async () => {
    const response = await api('mentor-a')
      .post(`/mentor-applications/${appId('A1')}/materials`)
      .send({ fileId: fileId('A1'), kind: 1 })
      .expect(201);
    const data = (response.body as ResponseEnvelope<MaterialResponseDto>).data;
    expect(BigInt(data.id)).not.toBe(firstMaterialId);
    expect(await materialCount('A1')).toBe(3);
  });

  // ── 判据 18 ───────────────────────────────────────────────────────

  it('判据 18：:materialId 不存在 / 已软删时预览下载 → 各 404 / 31107', async () => {
    const paths = [
      `/mentor-applications/${appId('A1')}/materials/999999/preview`,
      `/mentor-applications/${appId('A1')}/materials/999999/download`,
      `/mentor-applications/${appId('A1')}/materials/${firstMaterialId.toString()}/preview`,
      `/mentor-applications/${appId('A1')}/materials/${firstMaterialId.toString()}/download`,
    ];
    for (const path of paths) {
      const response = await api('mentor-a').get(path).expect(404);
      const body = response.body as ResponseEnvelope<null>;
      expect(body.code).toBe(ErrorCode.MENTOR_MATERIAL_NOT_FOUND);
      expect(body.message).toBe('佐证材料不存在');
    }
  });

  // ── 判据 19 ───────────────────────────────────────────────────────

  it('判据 19：通用文件面未破——GET /files/:id/preview 仍按 file:list 门走，没有按申请的校验', async () => {
    // 持 file:list 的运维能下任何文件（通用面），说明没被加上按申请的校验
    const allowed = await api('ops-admin')
      .get(`/files/${fileId('A1')}/preview`)
      .expect(200);
    expect(Buffer.compare(allowed.body as Buffer, PDF)).toBe(0);

    // 不持 file:list 的导师被权限门拦下（403 / 10003）
    const denied = await api('mentor-a')
      .get(`/files/${fileId('A1')}/preview`)
      .expect(403);
    expect((denied.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  // ── 判据 20 ───────────────────────────────────────────────────────

  it('判据 20：材料面恰好 4 条路径 / 5 个操作（docs:gen 总数由门槛命令核）', () => {
    const document = buildDocument(app);
    const paths = document.paths as Record<string, Record<string, unknown>>;
    const materialPaths = Object.keys(paths).filter((path) =>
      path.startsWith('/mentor-applications/{id}/materials'),
    );
    expect(materialPaths.sort()).toEqual([
      '/mentor-applications/{id}/materials',
      '/mentor-applications/{id}/materials/{materialId}',
      '/mentor-applications/{id}/materials/{materialId}/download',
      '/mentor-applications/{id}/materials/{materialId}/preview',
    ]);
    const operations = materialPaths.reduce(
      (sum, path) =>
        sum +
        Object.keys(paths[path]).filter((key) =>
          ['get', 'post', 'put', 'delete', 'patch'].includes(key),
        ).length,
      0,
    );
    expect(operations).toBe(5);
  });
});

/**
 * 清残留（照 mentor-application.e2e-spec.ts 的同名函数）。走裸 SQL：清库是测试的
 * 运维动作，不是业务写入。顺序按外键拓扑序——material 先于 application，再 profile，
 * 再 sync_person / sync_org_unit。
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
