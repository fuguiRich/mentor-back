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
import type { MentorSearchDetailResponseDto } from '../src/modules/mentor-search/dto/mentor-search-response.dto';
import type { MentorSearchPageResponseDto } from '../src/modules/mentor-search/dto/query-mentor.dto';
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

const SYNCED_AT = new Date('2026-10-27T00:00:00.000Z');

/** 列表项恰好这 7 个键（R27：学号 / 学院 / 专业 / 行政班级等学生字段一个都不许有） */
const ITEM_KEYS = [
  'deptName',
  'id',
  'mentorType',
  'name',
  'professionalTitle',
  'researchFields',
  'summary',
].sort();

/** 详情 = 列表项 + 这 5 个键 */
const DETAIL_KEYS = [
  ...ITEM_KEYS,
  'affiliateOrg',
  'guidanceExperience',
  'mobile',
  'researchAchievements',
  'socialRoles',
].sort();

/**
 * 导师检索（学生侧）(e2e) —— Task 22 的全部判据。
 *
 * 共享库态、`maxWorkers: 1` 串行，执行顺序即判据顺序：
 * - 三个已生效导师（内校 / 外校 / 内校）+ 一个在审 + 一个草稿；
 * - 周三时段三种形态：mentor-a 开放、mentor-b 关闭、mentor-c 已软删；
 * - `S001` 是学生（角色带 `mentor:search`），`no-perm` 的角色不带该码。
 *
 * docs:gen 的 56 路径 / 75 操作由门槛命令核；这里只钉检索面的路由形状
 * （2 条路径 / 2 个操作，P3 后为 3 条 / 3 个操作），与 mentor-slot 的同款判据一致。
 */
describe('导师检索（学生侧）(e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;

  let adminApi: E2eApi;
  const agents = new Map<string, E2eApi>();
  const permissionIds = new Map<string, string>();
  const deptIds = new Map<string, bigint>();
  const people = new Map<string, SyncPerson>();
  const profiles = new Map<string, MentorProfile>();

  /** mentor-a 的周三开放时段——判据 6 会把它关掉再打开 */
  let aWednesdaySlotId: bigint;

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
    const orgA = await createOrg('ORG-SEARCH-A', '学院 A 组织', dept('A'));
    const orgB = await createOrg('ORG-SEARCH-B', '学院 B 组织', dept('B'));

    const identities: Array<[string, string, string, bigint, string | null]> = [
      ['mentor-a', '张明远', 'internalMentor', orgA, '13800000001'],
      ['mentor-b', '李思齐', 'externalMentor', orgB, '13800000002'],
      ['mentor-c', '王海燕', 'internalMentor', orgA, null],
      ['mentor-pending', '待审导师', 'internalMentor', orgA, null],
      ['mentor-draft', '草稿导师', 'internalMentor', orgA, null],
      ['S001', '陈一鸣', 'student', orgA, null],
    ];
    for (const [login, realName, personType, orgUnitId, mobile] of identities) {
      const person = await runWithSyncWrite(() =>
        prisma.client.syncPerson.create({
          data: {
            login,
            realName,
            personType,
            orgUnitId,
            mobile,
            syncedAt: SYNCED_AT,
            createdBy: 0n,
            updatedBy: 0n,
          },
        }),
      );
      people.set(login, person);
    }

    // 角色：学生 / 导师各一个带 mentor:search；no-perm 的角色不带
    const studentRole = await createRoleWithCodes(
      '检索学生角色',
      'search_student',
      'self',
      ['mentor:search'],
    );
    const mentorRole = await createRoleWithCodes(
      '检索导师角色',
      'search_mentor',
      'self',
      ['mentor:search'],
    );
    const noPermRole = await createRoleWithCodes(
      '无检索权限角色',
      'no_search',
      'self',
      [],
    );

    // username = login：与真实同步建号的口径一致
    const users: Array<[string, bigint, RoleResponseDto]> = [
      ['S001', dept('A'), studentRole],
      ['mentor-a', dept('A'), mentorRole],
      ['no-perm', dept('A'), noPermRole],
    ];
    for (const [username, deptId, role] of users) {
      const user = await seedUser(prisma, { username, deptId });
      await linkUserRole(user.userId, BigInt(role.id));
    }

    for (const login of ['S001', 'mentor-a', 'no-perm']) {
      const tokens = await loginAs(app, login, 'Passw0rd!');
      agents.set(login, authedAgent(app, tokens.accessToken));
    }

    // 五份档案：三份已生效（2）、一份在审（1）、一份草稿（0）
    const profileSpecs: Array<[string, Partial<MentorProfile>]> = [
      [
        'mentor-a',
        {
          status: 2,
          researchFields: ['人工智能', '软件工程'],
          professionalTitle: '教授',
          summary: '长期从事人工智能研究。',
          researchAchievements: '主持省部级项目 2 项。',
          guidanceExperience: '指导研究生 12 名。',
        },
      ],
      [
        'mentor-b',
        {
          status: 2,
          researchFields: ['大数据'],
          professionalTitle: '高级工程师',
          summary: '企业实践指导。',
          researchAchievements: '完成横向课题 3 项。',
          guidanceExperience: '企业导师 5 年。',
          affiliateOrg: '某某研究院',
          socialRoles: '某某学会理事',
        },
      ],
      [
        'mentor-c',
        {
          status: 2,
          researchFields: ['外国语言学'],
          professionalTitle: '副教授',
          summary: '外语教学与跨文化研究。',
        },
      ],
      [
        'mentor-pending',
        {
          status: 1,
          researchFields: ['人工智能'],
          professionalTitle: '讲师',
          summary: '在审档案，不该被检索到。',
        },
      ],
      [
        'mentor-draft',
        {
          status: 0,
          researchFields: ['人工智能'],
          summary: '草稿档案，不该被检索到。',
        },
      ],
    ];
    for (const [login, spec] of profileSpecs) {
      const profile = await prisma.client.mentorProfile.create({
        data: {
          personId: personId(login),
          researchFields: spec.researchFields ?? [],
          status: spec.status ?? 0,
          ...(spec.summary === undefined ? {} : { summary: spec.summary }),
          ...(spec.researchAchievements === undefined
            ? {}
            : { researchAchievements: spec.researchAchievements }),
          ...(spec.guidanceExperience === undefined
            ? {}
            : { guidanceExperience: spec.guidanceExperience }),
          ...(spec.affiliateOrg === undefined
            ? {}
            : { affiliateOrg: spec.affiliateOrg }),
          ...(spec.socialRoles === undefined
            ? {}
            : { socialRoles: spec.socialRoles }),
          ...(spec.professionalTitle === undefined
            ? {}
            : { professionalTitle: spec.professionalTitle }),
          createdBy: 0n,
          updatedBy: 0n,
        },
      });
      profiles.set(login, profile);
    }

    // 周三时段的三种形态：开放 / 关闭 / 已软删（只有 mentor-a 该出现）
    aWednesdaySlotId = await createSlot('mentor-a', 3, 1);
    await createSlot('mentor-b', 3, 0);
    await createSlot('mentor-c', 3, 1, new Date('2026-10-29T00:00:00.000Z'));
    // 另一个 weekday 的开放时段：mentor-c 只在周五可约（判据 6 的反向对照）
    await createSlot('mentor-c', 5, 1);
  });

  afterAll(async () => {
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

  function personId(login: string): bigint {
    const person = people.get(login);
    if (person === undefined) {
      throw new Error(`没有 ${login} 的 SyncPerson`);
    }
    return person.id;
  }

  function profileId(login: string): string {
    const profile = profiles.get(login);
    if (profile === undefined) {
      throw new Error(`没有 ${login} 的导师档案`);
    }
    return profile.id.toString();
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

  async function createSlot(
    login: string,
    weekday: number,
    status: number,
    deletedAt?: Date,
  ): Promise<bigint> {
    const row = await prisma.client.mentorTimeSlot.create({
      data: {
        mentorProfileId: BigInt(profileId(login)),
        weekday,
        startTime: '09:00',
        endTime: '11:00',
        status,
        ...(deletedAt === undefined ? {} : { deletedAt, deletedBy: 0n }),
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
    if (codes.length === 0) {
      return role;
    }
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

  async function search(
    login: string,
    query: Record<string, string | number> = {},
  ): Promise<MentorSearchPageResponseDto> {
    const response = await api(login).get('/mentors').query(query).expect(200);
    const body = response.body as ResponseEnvelope<MentorSearchPageResponseDto>;
    expect(body.code).toBe(0);
    return body.data;
  }

  function idsOf(data: MentorSearchPageResponseDto): string[] {
    return data.list.map((item) => item.id);
  }

  // ── 判据 1：只出已生效 + 列表项形状（R27） ────────────────────────

  it('判据 1：GET /mentors → 200，只出 status=2 的三位导师，列表项恰好 7 个键', async () => {
    const data = await search('S001');

    expect(data.total).toBe(3);
    expect(data.page).toBe(1);
    expect(data.pageSize).toBe(20);
    expect(idsOf(data)).toEqual([
      profileId('mentor-a'),
      profileId('mentor-b'),
      profileId('mentor-c'),
    ]);
    // 在审 / 草稿一律查不到
    expect(idsOf(data)).not.toContain(profileId('mentor-pending'));
    expect(idsOf(data)).not.toContain(profileId('mentor-draft'));

    for (const item of data.list) {
      expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
    }

    const a = data.list.find((item) => item.id === profileId('mentor-a'));
    expect(a).toEqual({
      id: profileId('mentor-a'),
      name: '张明远',
      mentorType: 'internal',
      deptName: '学院 A 组织',
      professionalTitle: '教授',
      researchFields: ['人工智能', '软件工程'],
      summary: '长期从事人工智能研究。',
    });
    const b = data.list.find((item) => item.id === profileId('mentor-b'));
    expect(b).toMatchObject({
      name: '李思齐',
      mentorType: 'external',
      deptName: '学院 B 组织',
    });
  });

  // ── 判据 2：name 模糊 ────────────────────────────────────────────

  it('判据 2：name 模糊匹配 SyncPerson.realName（「张」只出张明远）', async () => {
    expect(idsOf(await search('S001', { name: '张' }))).toEqual([
      profileId('mentor-a'),
    ]);
    // 不存在的姓名 → 空列表（不是 404）
    expect(idsOf(await search('S001', { name: '不存在' }))).toEqual([]);
  });

  // ── 判据 3：mentorType（由 personType 推导） ─────────────────────

  it('判据 3：mentorType=external 只出外校；internal 只认 internalMentor（student 不算）', async () => {
    expect(idsOf(await search('S001', { mentorType: 'external' }))).toEqual([
      profileId('mentor-b'),
    ]);
    expect(idsOf(await search('S001', { mentorType: 'internal' }))).toEqual([
      profileId('mentor-a'),
      profileId('mentor-c'),
    ]);

    // 补集写法（personType != 'externalMentor'）会把 student 也算成 internal。
    // 把 mentor-c 临时改成 student：档案仍是 status=2（列表里看得见），但不再算 internal
    await runWithSyncWrite(() =>
      prisma.client.syncPerson.update({
        where: { id: personId('mentor-c') },
        data: { personType: 'student' },
      }),
    );
    try {
      expect(idsOf(await search('S001', { mentorType: 'internal' }))).toEqual([
        profileId('mentor-a'),
      ]);
      expect(idsOf(await search('S001'))).toContain(profileId('mentor-c'));
    } finally {
      await runWithSyncWrite(() =>
        prisma.client.syncPerson.update({
          where: { id: personId('mentor-c') },
          data: { personType: 'internalMentor' },
        }),
      );
    }
  });

  // ── 判据 4：researchField 精确项匹配 ────────────────────────────

  it('判据 4：researchField 是 JSON 数组的精确项匹配（「人工」不命中「人工智能」）', async () => {
    expect(idsOf(await search('S001', { researchField: '人工智能' }))).toEqual([
      profileId('mentor-a'),
    ]);
    expect(idsOf(await search('S001', { researchField: '人工' }))).toEqual([]);
  });

  // ── 判据 5：professionalTitle 模糊 ──────────────────────────────

  it('判据 5：professionalTitle 模糊匹配（「副教授」只出王海燕，「工程师」只出李思齐）', async () => {
    expect(
      idsOf(await search('S001', { professionalTitle: '副教授' })),
    ).toEqual([profileId('mentor-c')]);
    expect(
      idsOf(await search('S001', { professionalTitle: '工程师' })),
    ).toEqual([profileId('mentor-b')]);
  });

  // ── 判据 6：weekday 只认开放且未软删的时段 ───────────────────────

  it('判据 6：weekday=3 只出周三有开放时段的导师；关掉该时段后不再出现', async () => {
    // mentor-a 开放；mentor-b 的周三时段关闭；mentor-c 的周三时段已软删
    expect(idsOf(await search('S001', { weekday: 3 }))).toEqual([
      profileId('mentor-a'),
    ]);
    // mentor-c 只在周五可约
    expect(idsOf(await search('S001', { weekday: 5 }))).toEqual([
      profileId('mentor-c'),
    ]);

    await prisma.client.mentorTimeSlot.update({
      where: { id: aWednesdaySlotId },
      data: { status: 0 },
    });
    expect(idsOf(await search('S001', { weekday: 3 }))).toEqual([]);

    // 打开回来 → 重新出现（关的是时段，不是导师）
    await prisma.client.mentorTimeSlot.update({
      where: { id: aWednesdaySlotId },
      data: { status: 1 },
    });
    expect(idsOf(await search('S001', { weekday: 3 }))).toEqual([
      profileId('mentor-a'),
    ]);
  });

  // ── 判据 7：deptId 精确（SyncOrgUnit.deptId 投影） ───────────────

  it('判据 7：deptId 精确匹配学院投影（A 出两位内校，B 只出外校）', async () => {
    expect(
      idsOf(await search('S001', { deptId: dept('A').toString() })),
    ).toEqual([profileId('mentor-a'), profileId('mentor-c')]);
    expect(
      idsOf(await search('S001', { deptId: dept('B').toString() })),
    ).toEqual([profileId('mentor-b')]);
  });

  // ── 判据 8：keyword 只匹配姓名 / 简介；方向归 researchField（R29） ──

  it('判据 8：keyword 只匹配 realName / summary；只在 researchFields 里的词 → 0 命中', async () => {
    // 姓名
    expect(idsOf(await search('S001', { keyword: '张明远' }))).toEqual([
      profileId('mentor-a'),
    ]);
    // 简介（「企业实践指导」只在 mentor-b 的 summary 里）
    expect(idsOf(await search('S001', { keyword: '企业实践' }))).toEqual([
      profileId('mentor-b'),
    ]);
    // R29 负例：「大数据」只出现在 mentor-b 的 researchFields 里 → keyword 搜不到
    expect(idsOf(await search('S001', { keyword: '大数据' }))).toEqual([]);
    // 同一字段的正例：方向走 researchField 的精确项匹配
    expect(idsOf(await search('S001', { researchField: '大数据' }))).toEqual([
      profileId('mentor-b'),
    ]);
  });

  // ── 判据 9：多条件 AND ──────────────────────────────────────────

  it('判据 9：多条件是 AND——单条件命中 2 人，加一条后只剩 1 人', async () => {
    const single = await search('S001', { mentorType: 'internal' });
    expect(idsOf(single)).toHaveLength(2);

    const combined = await search('S001', {
      mentorType: 'internal',
      professionalTitle: '副教授',
    });
    expect(idsOf(combined)).toEqual([profileId('mentor-c')]);

    // 互斥组合 → 空列表（AND 不是 OR）
    expect(
      idsOf(
        await search('S001', {
          mentorType: 'internal',
          deptId: dept('B').toString(),
        }),
      ),
    ).toEqual([]);
  });

  // ── 判据 10：分页结构 / pageSize 上限 ────────────────────────────

  it('判据 10：分页结构 { list, total, page, pageSize }；pageSize=101 → 400 / 10001', async () => {
    const second = await search('S001', { pageSize: 1, page: 2 });
    expect(second.total).toBe(3);
    expect(second.page).toBe(2);
    expect(second.pageSize).toBe(1);
    expect(idsOf(second)).toEqual([profileId('mentor-b')]);

    const response = await api('S001')
      .get('/mentors')
      .query({ pageSize: 101 })
      .expect(400);
    const body = response.body as ResponseEnvelope<{ fields: FieldErrorDto[] }>;
    expect(body.code).toBe(ErrorCode.PARAM_INVALID);
    expect(body.data.fields.some((field) => field.field === 'pageSize')).toBe(
      true,
    );
  });

  // ── 判据 11：非法筛选值 → 400 / 10001 ────────────────────────────

  it('判据 11：mentorType=foo / weekday=0 / weekday=8 → 各 400 / 10001', async () => {
    const cases: Array<[Record<string, string | number>, string]> = [
      [{ mentorType: 'foo' }, 'mentorType'],
      [{ weekday: 0 }, 'weekday'],
      [{ weekday: 8 }, 'weekday'],
    ];

    for (const [query, field] of cases) {
      const response = await api('S001')
        .get('/mentors')
        .query(query)
        .expect(400);
      const body = response.body as ResponseEnvelope<{
        fields: FieldErrorDto[];
      }>;
      expect(body.code).toBe(ErrorCode.PARAM_INVALID);
      expect(body.data.fields.some((item) => item.field === field)).toBe(true);
    }
  });

  // ── 判据 12：详情正例 ────────────────────────────────────────────

  it('判据 12：GET /mentors/:id（已生效）→ 200，详情字段 = 列表项 + 5 个键', async () => {
    const response = await api('S001')
      .get(`/mentors/${profileId('mentor-b')}`)
      .expect(200);
    const body =
      response.body as ResponseEnvelope<MentorSearchDetailResponseDto>;
    expect(body.code).toBe(0);

    expect(Object.keys(body.data).sort()).toEqual(DETAIL_KEYS);
    expect(body.data).toEqual({
      id: profileId('mentor-b'),
      name: '李思齐',
      mentorType: 'external',
      deptName: '学院 B 组织',
      professionalTitle: '高级工程师',
      researchFields: ['大数据'],
      summary: '企业实践指导。',
      researchAchievements: '完成横向课题 3 项。',
      guidanceExperience: '企业导师 5 年。',
      affiliateOrg: '某某研究院',
      socialRoles: '某某学会理事',
      mobile: '13800000002',
    });

    // 内校：affiliateOrg / socialRoles 为 null（R49），mobile 为 null 也照常返回
    const internal = await api('S001')
      .get(`/mentors/${profileId('mentor-c')}`)
      .expect(200);
    const internalData = (
      internal.body as ResponseEnvelope<MentorSearchDetailResponseDto>
    ).data;
    expect(internalData).toMatchObject({
      mentorType: 'internal',
      affiliateOrg: null,
      socialRoles: null,
      mobile: null,
    });
  });

  // ── 判据 13：详情负例（未生效 / 不存在）→ 404 / 31102 ────────────

  it('判据 13：在审 / 草稿 / 不存在的 :id → 各 404 / 31102', async () => {
    const ids = [
      profileId('mentor-pending'),
      profileId('mentor-draft'),
      '999999999',
    ];

    for (const id of ids) {
      const response = await api('S001').get(`/mentors/${id}`).expect(404);
      const body = response.body as ResponseEnvelope<null>;
      expect(body.code).toBe(ErrorCode.MENTOR_PROFILE_NOT_FOUND);
      expect(body.message).toBe('导师专业档案不存在');
    }
  });

  // ── 判据 16：人员已离场（SyncPerson 软删）→ 列表与详情都查不到 ─────

  it('判据 16：人员已离场 → 列表不出现，详情 404 / 31102', async () => {
    expect(idsOf(await search('S001'))).toContain(profileId('mentor-c'));

    // 同步任务的离场是 update 打 deletedAt，不是 delete
    await runWithSyncWrite(() =>
      prisma.client.syncPerson.update({
        where: { id: personId('mentor-c') },
        data: { deletedAt: new Date(), deletedBy: 0n },
      }),
    );
    try {
      const list = await search('S001');
      expect(idsOf(list)).not.toContain(profileId('mentor-c'));
      expect(list.total).toBe(2);

      const response = await api('S001')
        .get(`/mentors/${profileId('mentor-c')}`)
        .expect(404);
      const body = response.body as ResponseEnvelope<null>;
      expect(body.code).toBe(ErrorCode.MENTOR_PROFILE_NOT_FOUND);
      expect(body.message).toBe('导师专业档案不存在');
    } finally {
      await runWithSyncWrite(() =>
        prisma.client.syncPerson.update({
          where: { id: personId('mentor-c') },
          data: { deletedAt: null, deletedBy: null },
        }),
      );
    }

    // 复职后回到列表
    expect(idsOf(await search('S001'))).toContain(profileId('mentor-c'));
  });

  // ── 判据 17：档案已软删 → 列表不出现，详情 404 / 31102 ─────────────

  it('判据 17：档案已软删 → 列表不出现，详情 404 / 31102', async () => {
    const id = BigInt(profileId('mentor-b'));
    await prisma.client.mentorProfile.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: 0n },
    });
    try {
      expect(idsOf(await search('S001'))).not.toContain(profileId('mentor-b'));

      const response = await api('S001')
        .get(`/mentors/${profileId('mentor-b')}`)
        .expect(404);
      const body = response.body as ResponseEnvelope<null>;
      expect(body.code).toBe(ErrorCode.MENTOR_PROFILE_NOT_FOUND);
      expect(body.message).toBe('导师专业档案不存在');
    } finally {
      await prisma.client.mentorProfile.update({
        where: { id },
        data: { deletedAt: null, deletedBy: null },
      });
    }

    expect(idsOf(await search('S001'))).toContain(profileId('mentor-b'));
  });

  // ── 判据 14：权限面（有码即可 / 无码 403） ───────────────────────

  it('判据 14：学生与导师都能调；无码账号 403 / 10003；超管放行', async () => {
    // 学生（判据 1 已验 200），导师同样能调
    const asMentor = await api('mentor-a').get('/mentors').expect(200);
    expect(
      (asMentor.body as ResponseEnvelope<MentorSearchPageResponseDto>).code,
    ).toBe(0);
    // 超管跳过权限检查
    const asAdmin = await adminApi.get('/mentors').expect(200);
    expect(
      (asAdmin.body as ResponseEnvelope<MentorSearchPageResponseDto>).code,
    ).toBe(0);

    for (const path of ['/mentors', `/mentors/${profileId('mentor-a')}`]) {
      const response = await api('no-perm').get(path).expect(403);
      const body = response.body as ResponseEnvelope<null>;
      expect(body.code).toBe(ErrorCode.FORBIDDEN);
      expect(body.message).toBe('无权限访问：缺少 mentor:search');
    }
  });

  // ── 判据 15：检索面恰好 5 条路径 / 7 个操作 ──────────────────────

  it('判据 15：检索面恰好 5 条路径 / 7 个操作（docs:gen 总数由门槛命令核）', () => {
    const document = buildDocument(app);
    const paths = document.paths as Record<string, Record<string, unknown>>;
    const searchPaths = Object.keys(paths).filter((path) =>
      path.startsWith('/mentors'),
    );
    // 前缀 `/mentors` 下不止「检索」两件事：P3 又挂了两组子资源——
    // `GET /mentors/{mentorId}/reviews`（评价，Task 34）与
    // `/mentors/{mentorId}/achievements[/{achievementId}]`（成果，Task 36）。
    // 判据说的是「文档里 `/mentors` 下有什么」，所以它们必须算进来——
    // 把它们排除掉等于自欺。
    expect(searchPaths.sort()).toEqual([
      '/mentors',
      '/mentors/{id}',
      '/mentors/{mentorId}/achievements',
      '/mentors/{mentorId}/achievements/{achievementId}',
      '/mentors/{mentorId}/reviews',
    ]);
    const operations = searchPaths.reduce(
      (sum, path) =>
        sum +
        Object.keys(paths[path]).filter((key) =>
          ['get', 'post', 'put', 'delete', 'patch'].includes(key),
        ).length,
      0,
    );
    // 2（检索）+ 1（评价）+ 2（成果 post/get）+ 2（成果 patch/delete）= 7
    expect(operations).toBe(7);
  });
});

/**
 * 清残留（照 mentor-slot.e2e-spec.ts 的同名函数）。走裸 SQL：清库是测试的
 * 运维动作，不是业务写入。顺序按外键拓扑序——预约域先于时段，时段先于档案，
 * 档案先于 sync_person / sync_org_unit。
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
