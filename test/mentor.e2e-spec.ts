import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { MentorProfile, SyncPerson } from '@prisma/client';
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
import type { MentorProfileResponseDto } from '../src/modules/mentor/dto/mentor-profile.dto';
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
 * 导师专业档案 (e2e) —— brief §6 的 18 条判据（18 是 docs:gen 的 36 路径 / 51 操作，
 * 在报告里用 `pnpm docs:gen` 的实跑读数核，不在这里钉总数：总数会随 Task 13+ 长，
 * 钉死等于「一加业务接口就红」）。这里补一条**路由面**判据：/mentor/profile 上
 * 恰好 get + put 两条，多一条就是把 §1 之外的路由开出来了（红线 7）。
 *
 * 判据里的导师都走**真实权限路径**（sys_permission → 角色 → 用户），不靠超管绕。
 */

const SYNCED_AT = new Date('2026-10-27T00:00:00.000Z');

const MENTOR_ONLY_MESSAGE =
  '只有导师（internalMentor / externalMentor）有专业档案';

describe('导师专业档案 (e2e)', () => {
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
          code: 'ORG-MENTOR',
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
      await linkPermissions(login, user);
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

  /** 权限点 → 角色 → 用户（test/user.e2e-spec.ts 的 operatorAgent 套路） */
  async function linkPermissions(
    login: string,
    user: SeededUser,
  ): Promise<void> {
    const permIds = [
      await ensurePermissionId('mentor:profile'),
      await ensurePermissionId('mentor:profile-update'),
    ];
    const roleBody = await adminApi
      .post('/roles')
      .send({
        name: `导师档案角色 ${login}`,
        code: `mp_${login.replace(/-/g, '_')}`,
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

  /** 直接改库置 status（审核流的写口在 Task 13 / 14，测试造态只能这么造） */
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

  function draftFields(row: MentorProfile): Record<string, unknown> {
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

  it('判据 1：未建档 GET /mentor/profile → 404 / 31102「导师专业档案不存在」', async () => {
    const response = await api('mentor-a').get('/mentor/profile').expect(404);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.MENTOR_PROFILE_NOT_FOUND);
    expect(body.message).toBe('导师专业档案不存在');
    expect(body.data).toBeNull();
  });

  it('判据 2：首次 PUT（upsert 建行）→ 200；库里 1 行，status = 0、personId = 本人 SyncPerson.id', async () => {
    const response = await api('mentor-a')
      .put('/mentor/profile')
      .send(fullDraft({ summary: '简介初稿' }))
      .expect(200);
    const body = response.body as ResponseEnvelope<MentorProfileResponseDto>;
    expect(body.data.status).toBe(0);
    expect(body.data.personId).toBe(personId('mentor-a').toString());

    const rows = await prisma.client.mentorProfile.findMany({
      where: { personId: personId('mentor-a') },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(0);
    expect(rows[0].personId).toBe(personId('mentor-a'));
    expect(rows[0].summary).toBe('简介初稿');
    // R28：职称 / 资质随档案一起落库（内校也填）
    expect(rows[0].professionalTitle).toBe('职称一版');
  });

  it('判据 3：再次 PUT（更新）→ 200；仍是 1 行（不重复建），字段被改写', async () => {
    await api('mentor-a')
      .put('/mentor/profile')
      .send(fullDraft({ summary: '简介二稿', researchFields: ['创新创业'] }))
      .expect(200);

    const rows = await prisma.client.mentorProfile.findMany({
      where: { personId: personId('mentor-a') },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe('简介二稿');
    expect(rows[0].researchFields).toEqual(['创新创业']);
    expect(rows[0].researchAchievements).toBe('研究成果一版');
  });

  it('判据 4：GET 建档后 → 200，字段回显一致，id / personId 是字符串', async () => {
    const response = await api('mentor-a').get('/mentor/profile').expect(200);
    const data = (response.body as ResponseEnvelope<MentorProfileResponseDto>)
      .data;

    expect(typeof data.id).toBe('string');
    expect(typeof data.personId).toBe('string');
    expect(data.personId).toBe(personId('mentor-a').toString());
    expect(data).toMatchObject({
      mentorType: 'internal',
      researchFields: ['创新创业'],
      summary: '简介二稿',
      achievements: '研究成果一版',
      guidanceExperience: '指导经验一版',
      // 判据 6 的前站：校内导师的这两个字段恒 null（R49）
      affiliateOrg: null,
      socialRoles: null,
      // R28：内校也填——不被置 null
      professionalTitle: '职称一版',
      status: 0,
    });
  });

  it('判据 4b：联系电话可单独维护；null 清除；非法 / 学生 / 未建档各按码拒绝', async () => {
    const updated = await api('mentor-a')
      .put('/mentor/profile/contact')
      .send({ contactMobile: '13800138000' })
      .expect(200);
    expect(
      (updated.body as ResponseEnvelope<MentorProfileResponseDto>).data
        .contactMobile,
    ).toBe('13800138000');

    const got = await api('mentor-a').get('/mentor/profile').expect(200);
    expect(
      (got.body as ResponseEnvelope<MentorProfileResponseDto>).data
        .contactMobile,
    ).toBe('13800138000');

    const row = await prisma.client.mentorProfile.findFirst({
      where: { personId: personId('mentor-a') },
    });
    expect(row?.contactMobile).toBe('13800138000');

    // null = 清除覆盖，回退到同步源手机号
    const cleared = await api('mentor-a')
      .put('/mentor/profile/contact')
      .send({ contactMobile: null })
      .expect(200);
    expect(
      (cleared.body as ResponseEnvelope<MentorProfileResponseDto>).data
        .contactMobile,
    ).toBeNull();

    const invalid = await api('mentor-a')
      .put('/mentor/profile/contact')
      .send({ contactMobile: '123' })
      .expect(400);
    const invalidBody = invalid.body as ResponseEnvelope<{
      fields: FieldErrorDto[];
    }>;
    expect(invalidBody.code).toBe(ErrorCode.PARAM_INVALID);
    expect(
      invalidBody.data.fields.some((field) => field.field === 'contactMobile'),
    ).toBe(true);

    const student = await api('student-a')
      .put('/mentor/profile/contact')
      .send({ contactMobile: '13800138000' })
      .expect(403);
    expect((student.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );

    const noProfile = await api('mentor-b')
      .put('/mentor/profile/contact')
      .send({ contactMobile: '13800138000' })
      .expect(404);
    expect((noProfile.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.MENTOR_PROFILE_NOT_FOUND,
    );
  });

  it('判据 5：mentorType 两分支——internalMentor→internal，externalMentor→external', async () => {
    const internal = await api('mentor-a').get('/mentor/profile').expect(200);
    expect(
      (internal.body as ResponseEnvelope<MentorProfileResponseDto>).data
        .mentorType,
    ).toBe('internal');

    const created = await api('mentor-c')
      .put('/mentor/profile')
      .send(fullDraft())
      .expect(200);
    expect(
      (created.body as ResponseEnvelope<MentorProfileResponseDto>).data
        .mentorType,
    ).toBe('external');

    const external = await api('mentor-c').get('/mentor/profile').expect(200);
    expect(
      (external.body as ResponseEnvelope<MentorProfileResponseDto>).data
        .mentorType,
    ).toBe('external');
  });

  it('判据 6：校内导师传 affiliateOrg / socialRoles → 200，回显 null（R49 置空，不是 400）', async () => {
    const response = await api('mentor-a')
      .put('/mentor/profile')
      .send(
        fullDraft({
          affiliateOrg: '不该留住的合作单位',
          socialRoles: '不该留住的任职',
        }),
      )
      .expect(200);
    const data = (response.body as ResponseEnvelope<MentorProfileResponseDto>)
      .data;
    expect(data.affiliateOrg).toBeNull();
    expect(data.socialRoles).toBeNull();

    const row = await readRow('mentor-a');
    expect(row?.affiliateOrg).toBeNull();
    expect(row?.socialRoles).toBeNull();
  });

  it('判据 7：校外导师传 affiliateOrg / socialRoles → 200，回显原值', async () => {
    const response = await api('mentor-c')
      .put('/mentor/profile')
      .send(
        fullDraft({ affiliateOrg: '某某研究院', socialRoles: '某某学会理事' }),
      )
      .expect(200);
    const data = (response.body as ResponseEnvelope<MentorProfileResponseDto>)
      .data;
    expect(data.affiliateOrg).toBe('某某研究院');
    expect(data.socialRoles).toBe('某某学会理事');

    const row = await readRow('mentor-c');
    expect(row?.affiliateOrg).toBe('某某研究院');
    expect(row?.socialRoles).toBe('某某学会理事');
  });

  it('判据 8：researchFields 6 项 → 400 / 10001，data.fields 点名 researchFields', async () => {
    const response = await api('mentor-a')
      .put('/mentor/profile')
      .send(
        fullDraft({
          researchFields: ['一', '二', '三', '四', '五', '六'],
        }),
      )
      .expect(400);
    const body = response.body as ResponseEnvelope<{ fields: FieldErrorDto[] }>;
    expect(body.code).toBe(ErrorCode.PARAM_INVALID);
    expect(body.data.fields.some((f) => f.field === 'researchFields')).toBe(
      true,
    );
  });

  it('判据 9：researchFields 单项 31 字符 → 400 / 10001，点名 researchFields', async () => {
    const response = await api('mentor-a')
      .put('/mentor/profile')
      .send(
        fullDraft({
          researchFields: ['a'.repeat(31)],
        }),
      )
      .expect(400);
    const body = response.body as ResponseEnvelope<{ fields: FieldErrorDto[] }>;
    expect(body.code).toBe(ErrorCode.PARAM_INVALID);
    expect(body.data.fields.some((f) => f.field === 'researchFields')).toBe(
      true,
    );
  });

  it('判据 10：affiliateOrg 101 字符 → 400 / 10001', async () => {
    const response = await api('mentor-c')
      .put('/mentor/profile')
      .send(fullDraft({ affiliateOrg: 'a'.repeat(101) }))
      .expect(400);
    const body = response.body as ResponseEnvelope<{ fields: FieldErrorDto[] }>;
    expect(body.code).toBe(ErrorCode.PARAM_INVALID);
    expect(body.data.fields.some((f) => f.field === 'affiliateOrg')).toBe(true);
  });

  it('判据 10b（R28）：professionalTitle 101 字符 → 400 / 10001，data.fields 点名该字段', async () => {
    const response = await api('mentor-a')
      .put('/mentor/profile')
      .send(fullDraft({ professionalTitle: 'a'.repeat(101) }))
      .expect(400);
    const body = response.body as ResponseEnvelope<{ fields: FieldErrorDto[] }>;
    expect(body.code).toBe(ErrorCode.PARAM_INVALID);
    expect(body.data.fields.some((f) => f.field === 'professionalTitle')).toBe(
      true,
    );
  });

  it('判据 11：请求体塞 status: 2 → 400 / 10001，库里 status 仍是 0', async () => {
    const before = await readRow('mentor-a');
    expect(before?.status).toBe(0);

    const response = await api('mentor-a')
      .put('/mentor/profile')
      .send(fullDraft({ status: 2 }))
      .expect(400);
    const body = response.body as ResponseEnvelope<{ fields: FieldErrorDto[] }>;
    expect(body.code).toBe(ErrorCode.PARAM_INVALID);
    expect(body.data.fields.some((f) => f.field === 'status')).toBe(true);

    const after = await readRow('mentor-a');
    expect(after?.status).toBe(0);
    expect(after?.summary).toBe(before?.summary);
  });

  it('判据 12：请求体塞 personId / mentorType / id 任一 → 400 / 10001', async () => {
    for (const forbidden of ['personId', 'mentorType', 'id']) {
      const response = await api('mentor-a')
        .put('/mentor/profile')
        .send(fullDraft({ [forbidden]: '1' }))
        .expect(400);
      const body = response.body as ResponseEnvelope<{
        fields: FieldErrorDto[];
      }>;
      expect(body.code).toBe(ErrorCode.PARAM_INVALID);
      expect(body.data.fields.some((f) => f.field === forbidden)).toBe(true);
    }
  });

  it('判据 13：越权 ①——personType=student 调 GET / PUT → 403 / 10003（不是 404）', async () => {
    // 两条请求必须**逐条发**：supertest 7 会在「没有在途请求」时把自动起的
    // server 关掉，预先攒两条链会让第二条的 dispatch 拿到 address()=null
    // （user.e2e-spec.ts 开头那个坑）。
    const assertMentorOnly = (response: { body: unknown }): void => {
      const body = response.body as ResponseEnvelope<null>;
      expect(body.code).toBe(ErrorCode.FORBIDDEN);
      expect(body.message).toBe(MENTOR_ONLY_MESSAGE);
    };

    const got = await api('student-a').get('/mentor/profile').expect(403);
    assertMentorOnly(got);
    const put = await api('student-a')
      .put('/mentor/profile')
      .send(fullDraft())
      .expect(403);
    assertMentorOnly(put);

    // 学生的档案永远不存在：一个行都不许建出来
    expect(await readRow('student-a')).toBeNull();
  });

  it('判据 14：越权 ②——导师 A 的 PUT 之后，导师 B 的行逐字不动（含 updatedAt）', async () => {
    await api('mentor-b')
      .put('/mentor/profile')
      .send(fullDraft({ summary: 'B 的简介' }))
      .expect(200);
    const beforeB = await readRow('mentor-b');
    expect(beforeB).not.toBeNull();

    await api('mentor-a')
      .put('/mentor/profile')
      .send(fullDraft({ summary: 'A 又改了一次' }))
      .expect(200);

    const afterB = await readRow('mentor-b');
    expect(afterB).toEqual(beforeB);
  });

  it('判据 15：R55 status 门——库里置 status=2，PUT → 409 / 31103，7 个可填报字段逐字不变', async () => {
    const before = await readRow('mentor-c');
    expect(before).not.toBeNull();
    const fieldsBefore = draftFields(before as MentorProfile);

    await setStatus('mentor-c', 2);

    const response = await api('mentor-c')
      .put('/mentor/profile')
      .send(fullDraft({ summary: '已生效了还想改' }))
      .expect(409);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE);
    expect(body.message).toBe('导师专业档案已生效，改字段走信息修改申请');

    const after = await readRow('mentor-c');
    expect(draftFields(after as MentorProfile)).toEqual(fieldsBefore);
  });

  it('判据 16：status=1 / 4 / 5 调 PUT → 各 409 / 31103（三态都要）', async () => {
    const fieldsBefore = draftFields(
      (await readRow('mentor-c')) as MentorProfile,
    );

    const expectations: Array<[number, string]> = [
      [1, '导师专业档案在审，撤回后再改'],
      [4, '导师专业档案已冻结，不能修改'],
      [5, '导师专业档案已移除，不能修改'],
    ];
    for (const [status, message] of expectations) {
      await setStatus('mentor-c', status);
      const response = await api('mentor-c')
        .put('/mentor/profile')
        .send(fullDraft({ summary: `status=${status} 还想改` }))
        .expect(409);
      const body = response.body as ResponseEnvelope<null>;
      expect(body.code).toBe(ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE);
      expect(body.message).toBe(message);
    }

    const after = await readRow('mentor-c');
    expect(draftFields(after as MentorProfile)).toEqual(fieldsBefore);
  });

  it('判据 17：R55 只关写不关读——status=2 调 GET → 200，字段回显正常', async () => {
    await setStatus('mentor-c', 2);
    const response = await api('mentor-c').get('/mentor/profile').expect(200);
    const data = (response.body as ResponseEnvelope<MentorProfileResponseDto>)
      .data;
    expect(data.status).toBe(2);
    expect(data).toMatchObject({
      mentorType: 'external',
      researchFields: ['创新创业', '人工智能'],
      summary: '个人简介一版',
      achievements: '研究成果一版',
      guidanceExperience: '指导经验一版',
      affiliateOrg: '某某研究院',
      socialRoles: '某某学会理事',
      professionalTitle: '职称一版',
    });
  });

  it('路由面：/mentor/profile 上恰好 get + put，没有 §1 之外的路由（红线 7）', () => {
    const document = buildDocument(app);
    const item = document.paths['/mentor/profile'] as
      Record<string, unknown> | undefined;
    expect(item).toBeDefined();
    expect(Object.keys(item as Record<string, unknown>).sort()).toEqual([
      'get',
      'put',
    ]);
  });
});

/**
 * 清残留。走裸 SQL（照 sync-write-guard.e2e-spec.ts 的 clearSyncTables）：
 * 清库是测试的运维动作，不是业务写入。顺序按外键拓扑序——mentor_profile 的
 * 引用方（P3 的成果 / 考核…）先清，再 profile，再 sync_person / sync_org_unit。
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
