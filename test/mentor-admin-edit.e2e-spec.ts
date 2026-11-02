import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { MentorProfile, SyncPerson, SysOpLog } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { buildDocument, configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { runWithSyncWrite } from '../src/infra/prisma/sync-write-scope';
import { ErrorCode } from '../src/common/constants/error-code';
import type { FieldErrorDto } from '../src/common/dto/field-error.dto';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import { OpLogRepository } from '../src/modules/oplog/oplog.repository';
import type { PermissionResponseDto } from '../src/modules/permission/dto/permission-response.dto';
import type { RoleResponseDto } from '../src/modules/role/dto/role-response.dto';
import type { MentorProfileResponseDto } from '../src/modules/mentor/dto/mentor-profile.dto';
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
 * 后台改导师填报字段 (e2e) —— brief §5 的 14 条判据（14 是 docs:gen 的
 * 47 路径 / 64 操作，在报告里用实跑读数核，不在这里钉总数）。
 *
 * 判据里的管理员走**真实权限路径**（sys_permission → 角色 → 用户），
 * 不靠超管绕过：`mentor:admin-update` 不进 seed（`prisma/seed.ts` 不播权限点），
 * 本套件自建权限点并绑到 data_scope=all 的角色上。
 */

const SYNCED_AT = new Date('2026-10-27T00:00:00.000Z');
const ADMIN_PERMISSION = 'mentor:admin-update';

describe('后台改导师填报字段 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let admin: SeededUser;
  let adminApi: E2eApi;
  /** 双创学院管理员：有 mentor:admin-update + data_scope=all */
  let editorApi: E2eApi;
  /** 无权限账号（判据 7 / 12①） */
  let plainApi: E2eApi;

  const people = new Map<string, SyncPerson>();
  const permissionIds = new Map<string, string>();

  let internalProfileId: bigint;
  let externalProfileId: bigint;
  let deletedProfileId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);

    await clearMentorAndSyncTables(prisma);
    await clearModuleTables(prisma);
    await clearBusinessTables(prisma);
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
          code: 'ORG-ADMIN-EDIT',
          name: '创新创业学院',
          syncedAt: SYNCED_AT,
          createdBy: 0n,
          updatedBy: 0n,
        },
      }),
    );

    const identities: Array<[string, string]> = [
      ['edit-internal', 'internalMentor'],
      ['edit-external', 'externalMentor'],
      ['edit-deleted', 'internalMentor'],
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
    }

    internalProfileId = await seedProfile('edit-internal', 2, {
      researchFields: ['方向一', '方向二'],
      summary: '原简介',
      researchAchievements: '原成果',
      guidanceExperience: '原经验',
      affiliateOrg: null,
      socialRoles: null,
      professionalTitle: '副教授',
    });
    externalProfileId = await seedProfile('edit-external', 2, {
      researchFields: ['外部方向'],
      summary: '外部简介',
      researchAchievements: '外成果',
      guidanceExperience: '外经验',
      affiliateOrg: '原单位',
      socialRoles: '原任职',
      professionalTitle: '教授',
    });
    deletedProfileId = await seedProfile('edit-deleted', 2, {
      summary: '已软删的档案',
    });
    // 软删：update 单数不拦，读走 client 会自动过滤 deletedAt
    await prisma.client.mentorProfile.update({
      where: { id: deletedProfileId },
      data: { deletedAt: new Date(), deletedBy: admin.userId },
    });

    // 权限点 → 角色（data_scope=all）→ 用户，走真实权限路径
    const permissionId = await ensurePermissionId(ADMIN_PERMISSION);
    const role = await createRole('后台改档管理员', 'admin_edit_role', 'all');
    await adminApi
      .put(`/roles/${role.id}/permissions`)
      .send({ permissionIds: [permissionId] })
      .expect(200);

    const editor = await seedUser(prisma, {
      username: 'admin-editor',
      deptId: root.id,
    });
    await prisma.client.sysUserRole.create({
      data: {
        userId: editor.userId,
        roleId: BigInt(role.id),
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    editorApi = authedAgent(
      app,
      (await loginAs(app, 'admin-editor', editor.password)).accessToken,
    );

    const plain = await seedUser(prisma, {
      username: 'plain-editor',
      deptId: root.id,
    });
    plainApi = authedAgent(
      app,
      (await loginAs(app, 'plain-editor', plain.password)).accessToken,
    );
  });

  afterAll(async () => {
    try {
      if (prisma !== undefined) {
        await clearMentorAndSyncTables(prisma);
        await clearModuleTables(prisma);
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

  async function seedProfile(
    login: string,
    status: number,
    overrides: Partial<{
      researchFields: string[];
      summary: string;
      researchAchievements: string;
      guidanceExperience: string;
      affiliateOrg: string | null;
      socialRoles: string | null;
      professionalTitle: string | null;
    }> = {},
  ): Promise<bigint> {
    const person = people.get(login);
    if (person === undefined) {
      throw new Error(`没有 ${login} 的 SyncPerson`);
    }
    const row = await prisma.client.mentorProfile.create({
      data: {
        personId: person.id,
        status,
        researchFields: overrides.researchFields ?? [],
        summary: overrides.summary ?? null,
        researchAchievements: overrides.researchAchievements ?? null,
        guidanceExperience: overrides.guidanceExperience ?? null,
        affiliateOrg: overrides.affiliateOrg ?? null,
        socialRoles: overrides.socialRoles ?? null,
        professionalTitle: overrides.professionalTitle ?? null,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    return row.id;
  }

  async function createRole(
    name: string,
    code: string,
    dataScope: string,
  ): Promise<RoleResponseDto> {
    const response = await adminApi
      .post('/roles')
      .send({ name, code, dataScope })
      .expect(201);
    return (response.body as ResponseEnvelope<RoleResponseDto>).data;
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

  function personId(login: string): bigint {
    const person = people.get(login);
    if (person === undefined) {
      throw new Error(`没有 ${login} 的 SyncPerson`);
    }
    return person.id;
  }

  async function readProfile(id: bigint): Promise<MentorProfile | null> {
    return prisma.client.mentorProfile.findFirst({ where: { id } });
  }

  /** 本任务的留痕行（module + action 唯一定位） */
  async function editLogs(): Promise<SysOpLog[]> {
    return prisma.client.sysOpLog.findMany({
      where: { module: 'mentor', action: 'admin-update-profile' },
      orderBy: { id: 'asc' },
    });
  }

  async function logCount(): Promise<number> {
    return prisma.client.sysOpLog.count({
      where: { module: 'mentor', action: 'admin-update-profile' },
    });
  }

  function profileFields(row: MentorProfile): Record<string, unknown> {
    return {
      researchFields: row.researchFields,
      summary: row.summary,
      achievements: row.researchAchievements,
      guidanceExperience: row.guidanceExperience,
      affiliateOrg: row.affiliateOrg,
      socialRoles: row.socialRoles,
      professionalTitle: row.professionalTitle,
    };
  }

  it('判据 1 + 2 + 3：管理员改 summary → 200；库里字段已改，status / personId 逐字不变；留痕 before / after 是 7 字段完整快照', async () => {
    const before = await readProfile(internalProfileId);
    if (before === null) {
      throw new Error('内部导师档案未种出');
    }
    const logsBefore = await logCount();

    const response = await editorApi
      .put(`/mentor/profiles/${internalProfileId.toString()}`)
      .send({ summary: '管理员改后' })
      .expect(200);
    const data = (response.body as ResponseEnvelope<MentorProfileResponseDto>)
      .data;

    // 判据 1：只改 summary，status / personId 不变
    expect(data).toMatchObject({
      id: internalProfileId.toString(),
      personId: personId('edit-internal').toString(),
      mentorType: 'internal',
      researchFields: ['方向一', '方向二'],
      summary: '管理员改后',
      achievements: '原成果',
      guidanceExperience: '原经验',
      affiliateOrg: null,
      socialRoles: null,
      professionalTitle: '副教授',
      status: 2,
    });

    const after = await readProfile(internalProfileId);
    expect(after).not.toBeNull();
    expect(after?.status).toBe(before.status);
    expect(after?.personId).toBe(before.personId);
    expect(after?.summary).toBe('管理员改后');

    // 判据 2：SysOpLog 多一行，targetType / targetId 对，before / after 完整
    expect(await logCount()).toBe(logsBefore + 1);
    const logs = await editLogs();
    const log = logs[logs.length - 1];
    expect(log).toMatchObject({
      module: 'mentor',
      action: 'admin-update-profile',
      targetType: 'mentorProfile',
      targetId: internalProfileId.toString(),
      status: 1,
      method: 'PUT',
      path: `/mentor/profiles/${internalProfileId.toString()}`,
    });

    // 判据 3：before 是改动前的值（不是新值、不是 null）
    expect(log.before).toEqual({
      researchFields: ['方向一', '方向二'],
      summary: '原简介',
      achievements: '原成果',
      guidanceExperience: '原经验',
      affiliateOrg: null,
      socialRoles: null,
      professionalTitle: '副教授',
    });
    expect(log.after).toEqual({
      researchFields: ['方向一', '方向二'],
      summary: '管理员改后',
      achievements: '原成果',
      guidanceExperience: '原经验',
      affiliateOrg: null,
      socialRoles: null,
      professionalTitle: '副教授',
    });
  });

  it('判据 4：R49 内校导师改 affiliateOrg / socialRoles → 200，回显 null（不是 400，不是原值）', async () => {
    const response = await editorApi
      .put(`/mentor/profiles/${internalProfileId.toString()}`)
      .send({ affiliateOrg: '不该留住的单位', socialRoles: '不该留住的任职' })
      .expect(200);
    const data = (response.body as ResponseEnvelope<MentorProfileResponseDto>)
      .data;
    expect(data.affiliateOrg).toBeNull();
    expect(data.socialRoles).toBeNull();

    const row = await readProfile(internalProfileId);
    expect(row?.affiliateOrg).toBeNull();
    expect(row?.socialRoles).toBeNull();

    // 留痕的 after 也必须是 null（R49 在合并时就置空）
    const logs = await editLogs();
    expect(logs[logs.length - 1].after).toMatchObject({
      affiliateOrg: null,
      socialRoles: null,
    });
  });

  it('判据 5：R49 外校导师改这两个字段 → 200，回显原值', async () => {
    const response = await editorApi
      .put(`/mentor/profiles/${externalProfileId.toString()}`)
      .send({ affiliateOrg: '新合作单位', socialRoles: '新社会任职' })
      .expect(200);
    const data = (response.body as ResponseEnvelope<MentorProfileResponseDto>)
      .data;
    expect(data.affiliateOrg).toBe('新合作单位');
    expect(data.socialRoles).toBe('新社会任职');

    const row = await readProfile(externalProfileId);
    expect(row?.affiliateOrg).toBe('新合作单位');
    expect(row?.socialRoles).toBe('新社会任职');
  });

  it('判据 6 + 12③：:id 不存在 / 已软删 → 各 404 / 31102；只有这两次有 status=0 的日志行', async () => {
    for (const missing of [999999999999n, deletedProfileId]) {
      const logsBefore = await logCount();
      const response = await editorApi
        .put(`/mentor/profiles/${missing.toString()}`)
        .send({ summary: '不存在' })
        .expect(404);
      const body = response.body as ResponseEnvelope<null>;
      expect(body.code).toBe(ErrorCode.MENTOR_PROFILE_NOT_FOUND);
      expect(body.message).toBe('导师专业档案不存在');

      // 判据 12③：进到 service 才抛，有 status=0 的日志行（errorCode=31102）
      expect(await logCount()).toBe(logsBefore + 1);
      const logs = await editLogs();
      const log = logs[logs.length - 1];
      expect(log).toMatchObject({
        targetType: 'mentorProfile',
        targetId: missing.toString(),
        status: 0,
        errorCode: ErrorCode.MENTOR_PROFILE_NOT_FOUND,
      });
    }
  });

  it('判据 7 + 12①：无 mentor:admin-update 的人调 → 403 / 10003（消息点名权限码），库里字段未变、无日志行', async () => {
    const before = await readProfile(internalProfileId);
    const logsBefore = await logCount();

    const response = await plainApi
      .put(`/mentor/profiles/${internalProfileId.toString()}`)
      .send({ summary: '越权修改' })
      .expect(403);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.FORBIDDEN);
    expect(body.message).toContain(ADMIN_PERMISSION);

    expect(await readProfile(internalProfileId)).toEqual(before);
    // PermissionGuard 挡在 service 之前：一行日志都不落
    expect(await logCount()).toBe(logsBefore);
  });

  it('判据 8 + 12②：请求体塞 status → 400 / 10001，库里 status 仍是原值、无日志行', async () => {
    const before = await readProfile(internalProfileId);
    const logsBefore = await logCount();

    const response = await editorApi
      .put(`/mentor/profiles/${internalProfileId.toString()}`)
      .send({ status: 2 })
      .expect(400);
    const body = response.body as ResponseEnvelope<{ fields: FieldErrorDto[] }>;
    expect(body.code).toBe(ErrorCode.PARAM_INVALID);
    expect(body.data.fields.some((field) => field.field === 'status')).toBe(
      true,
    );

    expect((await readProfile(internalProfileId))?.status).toBe(before?.status);
    expect(await logCount()).toBe(logsBefore);
  });

  it('判据 9：请求体塞 personId / mentorType / id 任一 → 400 / 10001', async () => {
    for (const forbidden of ['personId', 'mentorType', 'id']) {
      const response = await editorApi
        .put(`/mentor/profiles/${internalProfileId.toString()}`)
        .send({ summary: '合法', [forbidden]: '1' })
        .expect(400);
      const body = response.body as ResponseEnvelope<{
        fields: FieldErrorDto[];
      }>;
      expect(body.code).toBe(ErrorCode.PARAM_INVALID);
      expect(body.data.fields.some((field) => field.field === forbidden)).toBe(
        true,
      );
    }
  });

  it('判据 10：summary 2001 字符 / researchFields 6 项 / 单项 31 字符 → 各 400 / 10001，点名对应字段', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ summary: 'a'.repeat(2001) }, 'summary'],
      [
        {
          researchFields: ['一', '二', '三', '四', '五', '六'],
        },
        'researchFields',
      ],
      [{ researchFields: ['a'.repeat(31)] }, 'researchFields'],
    ];
    for (const [payload, field] of cases) {
      const response = await editorApi
        .put(`/mentor/profiles/${internalProfileId.toString()}`)
        .send(payload)
        .expect(400);
      const body = response.body as ResponseEnvelope<{
        fields: FieldErrorDto[];
      }>;
      expect(body.code).toBe(ErrorCode.PARAM_INVALID);
      expect(body.data.fields.some((item) => item.field === field)).toBe(true);
    }
  });

  it('判据 11：status=0/1/2/3/4/5 各改一次 → 各 200，且接口不改 status', async () => {
    for (const status of [0, 1, 2, 3, 4, 5]) {
      await prisma.client.mentorProfile.update({
        where: { id: internalProfileId },
        data: { status },
      });

      const response = await editorApi
        .put(`/mentor/profiles/${internalProfileId.toString()}`)
        .send({ summary: `status=${status} 时管理员改的` })
        .expect(200);
      const data = (response.body as ResponseEnvelope<MentorProfileResponseDto>)
        .data;
      expect(data.status).toBe(status);
      expect(data.summary).toBe(`status=${status} 时管理员改的`);

      const row = await readProfile(internalProfileId);
      expect(row?.status).toBe(status);
      expect(row?.summary).toBe(`status=${status} 时管理员改的`);
    }
  });

  it('判据 13：留痕写失败 → 业务回滚，库里字段未改', async () => {
    const before = await readProfile(internalProfileId);
    if (before === null) {
      throw new Error('内部导师档案未种出');
    }
    const successLogsBefore = await prisma.client.sysOpLog.count({
      where: {
        module: 'mentor',
        action: 'admin-update-profile',
        status: 1,
        targetId: internalProfileId.toString(),
      },
    });

    // **不 mock `OpLogService.record`**：判据 13 钉的是 R77 的「传了 tx 就外抛」，
    // mock 掉 service 就绕过了 tx 分支，探针 6 永远转不红（评审 P1-1）。
    // 让真实的 record 跑起来，把失败点放在它委托的仓储上——这才是 tx 分支的实际路径。
    const opLogRepository = app.get(OpLogRepository);
    const spy = jest
      .spyOn(opLogRepository, 'insert')
      .mockRejectedValueOnce(new Error('oplog insert down'));
    let response: { status: number } = { status: 0 };
    try {
      response = await editorApi
        .put(`/mentor/profiles/${internalProfileId.toString()}`)
        .send({ summary: '留痕失败不该落库' });
    } finally {
      spy.mockRestore();
    }

    // 留痕抛错 → 整件回滚 → 500（不是 200）
    expect(response.status).toBe(500);
    const after = await readProfile(internalProfileId);
    expect(after?.summary).toBe(before.summary);
    expect(profileFields(after as MentorProfile)).toEqual(
      profileFields(before),
    );

    // 没有 status=1 的成功留痕行（失败时只允许旁路写 status=0）
    const successLogsAfter = await prisma.client.sysOpLog.count({
      where: {
        module: 'mentor',
        action: 'admin-update-profile',
        status: 1,
        targetId: internalProfileId.toString(),
      },
    });
    expect(successLogsAfter).toBe(successLogsBefore);
  });

  it('路由面：/mentor/profiles/{id} 上恰好 put；/mentor/profile 仍是 get + put', () => {
    const document = buildDocument(app);
    const adminEdit = document.paths['/mentor/profiles/{id}'] as
      Record<string, unknown> | undefined;
    expect(adminEdit).toBeDefined();
    expect(Object.keys(adminEdit as Record<string, unknown>).sort()).toEqual([
      'put',
    ]);

    const mine = document.paths['/mentor/profile'] as
      Record<string, unknown> | undefined;
    expect(Object.keys(mine as Record<string, unknown>).sort()).toEqual([
      'get',
      'put',
    ]);
  });
});

/**
 * 清残留。走裸 SQL（照 mentor.e2e-spec.ts 的同名函数）：清库是测试的运维动作，
 * 不是业务写入。顺序按外键拓扑序——引用方先清，再 profile，再 sync_person /
 * sync_org_unit。
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
