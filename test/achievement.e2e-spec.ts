import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { runWithSyncWrite } from '../src/infra/prisma/sync-write-scope';
import { ErrorCode } from '../src/common/constants/error-code';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import type {
  AchievementListResponseDto,
  AchievementResponseDto,
} from '../src/modules/achievement/dto/achievement-response.dto';
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
 * 双创成果登记接口（P3 Task 36）。
 *
 * 四条路由的守卫、软删、筛选与部门可见性各一条；日期字段单独钉一条
 * （`DATE` 列跨时区最容易差一天）。
 */
describe('双创成果登记（P3 Task 36）(e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const agents = new Map<string, E2eApi>();
  const permissionIds = new Map<string, bigint>();
  const people = new Map<string, bigint>();
  const deptIds = new Map<string, bigint>();
  let mentorAId: bigint;
  let mentorBId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);

    await clearAchievementTables(prisma);
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
    deptIds.set('A', await createDept('成果学院 A', rootDept.id));
    deptIds.set('B', await createDept('成果学院 B', rootDept.id));

    const orgA = await createOrg('ORG-ACH-A', '成果 A 组织', dept('A'));
    const orgB = await createOrg('ORG-ACH-B', '成果 B 组织', dept('B'));

    for (const [login, realName, personType, orgUnitId] of [
      ['ach-mentor-a', '成果导师甲', 'internalMentor', orgA],
      ['ach-mentor-b', '成果导师乙', 'internalMentor', orgB],
    ] as const) {
      const person = await runWithSyncWrite(() =>
        prisma.client.syncPerson.create({
          data: {
            login,
            realName,
            personType,
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
          personId: personOf('ach-mentor-a'),
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
          personId: personOf('ach-mentor-b'),
          researchFields: ['智能制造'],
          status: 2,
          createdBy: 0n,
          updatedBy: 0n,
        },
      })
    ).id;

    // 导师：能登记、能看；二级学院管理员：只能看，且 `dept`（不含下级）
    const mentorRole = await createRole('导师', 'ach_mentor', 'self', [
      'achievement:manage',
      'achievement:list',
    ]);
    const collegeRole = await createRole(
      '成果学院管理员',
      'ach_college',
      'dept',
      ['achievement:list'],
    );

    const users: Array<[string, bigint, bigint]> = [
      ['ach-mentor-a', mentorRole, dept('A')],
      ['ach-mentor-b', mentorRole, dept('B')],
      ['ach-college', collegeRole, dept('A')],
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
        await clearAchievementTables(prisma);
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

  function body(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      type: 1,
      title: '中国国际大学生创新大赛省级银奖',
      level: 2,
      awardedAt: '2026-09-15',
      ...overrides,
    };
  }

  it('判据 1：导师登记自己的成果 → 201，awardedAt 回 `YYYY-MM-DD`（不带时刻）', async () => {
    const response = await api('ach-mentor-a')
      .post(`/mentors/${mentorAId.toString()}/achievements`)
      .send(body({ description: '团队 5 人，本人为第一指导教师。' }))
      .expect(201);

    const data = (response.body as ResponseEnvelope<AchievementResponseDto>)
      .data;
    expect(data).toMatchObject({
      mentorProfileId: mentorAId.toString(),
      type: 1,
      title: '中国国际大学生创新大赛省级银奖',
      level: 2,
      // DATE 列只输出日期：带 T00:00:00Z 会让前端在东八区显示成前一天
      awardedAt: '2026-09-15',
      description: '团队 5 人，本人为第一指导教师。',
      proofFileId: null,
    });
  });

  it('判据 2：登记到别人的档案 → 404 / 31102（不是 403，藏存在性）', async () => {
    const response = await api('ach-mentor-a')
      .post(`/mentors/${mentorBId.toString()}/achievements`)
      .send(body())
      .expect(404);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.MENTOR_PROFILE_NOT_FOUND,
    );
  });

  it('判据 3：type / level / awardedAt 越界 → 400 / 10001', async () => {
    for (const bad of [
      { type: 9 },
      { level: 6 },
      { awardedAt: '2026-13-01' },
    ]) {
      const response = await api('ach-mentor-a')
        .post(`/mentors/${mentorAId.toString()}/achievements`)
        .send(body(bad))
        .expect(400);
      expect((response.body as ResponseEnvelope<null>).code).toBe(
        ErrorCode.PARAM_INVALID,
      );
    }
  });

  it('判据 4：PATCH 带 type → 400 / 10001（类型不可改）', async () => {
    const created = await api('ach-mentor-a')
      .post(`/mentors/${mentorAId.toString()}/achievements`)
      .send(body({ type: 2, title: '国家级大创项目立项' }))
      .expect(201);
    const id = (created.body as ResponseEnvelope<AchievementResponseDto>).data
      .id;

    const response = await api('ach-mentor-a')
      .patch(`/mentors/${mentorAId.toString()}/achievements/${id}`)
      .send({ type: 1 })
      .expect(400);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PARAM_INVALID,
    );
  });

  it('判据 5：PATCH 别人的成果 → 404 / 36001', async () => {
    const created = await api('ach-mentor-b')
      .post(`/mentors/${mentorBId.toString()}/achievements`)
      .send(body())
      .expect(201);
    const foreignId = (created.body as ResponseEnvelope<AchievementResponseDto>)
      .data.id;

    // 路径里的 mentorId 是本人的，成果却是别人的 → 归属不符
    const response = await api('ach-mentor-a')
      .patch(`/mentors/${mentorAId.toString()}/achievements/${foreignId}`)
      .send({ title: '改别人的' })
      .expect(404);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.ACHIEVEMENT_NOT_FOUND,
    );
  });

  it('判据 6：列表按 type / year 筛选，按 awardedAt 倒序', async () => {
    // 造一条 2025 年的成果，year=2026 时不该出现
    await api('ach-mentor-a')
      .post(`/mentors/${mentorAId.toString()}/achievements`)
      .send(body({ awardedAt: '2025-03-01', title: '2025 年的省级奖项' }))
      .expect(201);

    const all = await api('ach-mentor-a')
      .get(`/mentors/${mentorAId.toString()}/achievements`)
      .expect(200);
    const allData = (all.body as ResponseEnvelope<AchievementListResponseDto>)
      .data;
    // 判据 1 的一条 + 判据 4 的一条 + 本条的 2025 一条
    expect(allData.total).toBe(3);
    expect(allData.list.map((item) => item.awardedAt)).toEqual([
      '2026-09-15',
      '2026-09-15',
      '2025-03-01',
    ]);

    const y2026 = await api('ach-mentor-a')
      .get(`/mentors/${mentorAId.toString()}/achievements`)
      .query({ year: 2026 })
      .expect(200);
    const y2026Data = (
      y2026.body as ResponseEnvelope<AchievementListResponseDto>
    ).data;
    expect(y2026Data.total).toBe(2);
    expect(
      y2026Data.list.every((item) => item.awardedAt.startsWith('2026-')),
    ).toBe(true);

    const onlyType1 = await api('ach-mentor-a')
      .get(`/mentors/${mentorAId.toString()}/achievements`)
      .query({ type: 1 })
      .expect(200);
    expect(
      (onlyType1.body as ResponseEnvelope<AchievementListResponseDto>).data
        .total,
    ).toBe(2);
  });

  it('判据 7：DELETE 是软删——列表消失，库里仍有行', async () => {
    const created = await api('ach-mentor-a')
      .post(`/mentors/${mentorAId.toString()}/achievements`)
      .send(body({ title: '待摘除的成果' }))
      .expect(201);
    const id = (created.body as ResponseEnvelope<AchievementResponseDto>).data
      .id;

    await api('ach-mentor-a')
      .delete(`/mentors/${mentorAId.toString()}/achievements/${id}`)
      .expect(200);

    const list = await api('ach-mentor-a')
      .get(`/mentors/${mentorAId.toString()}/achievements`)
      .expect(200);
    const listData = (list.body as ResponseEnvelope<AchievementListResponseDto>)
      .data;
    expect(listData.list.some((item) => item.id === id)).toBe(false);

    const row = await prisma.includingDeleted.achievement.findFirst({
      where: { id: BigInt(id) },
    });
    expect(row?.deletedAt).not.toBeNull();
  });

  it('判据 8：学院管理员看本院 → 200；跨院 → 403 / 10003', async () => {
    await api('ach-college')
      .get(`/mentors/${mentorAId.toString()}/achievements`)
      .expect(200);

    const response = await api('ach-college')
      .get(`/mentors/${mentorBId.toString()}/achievements`)
      .expect(403);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  it('判据 9：导师看别人的成果列表 → 403 / 10003（self 范围）', async () => {
    const response = await api('ach-mentor-a')
      .get(`/mentors/${mentorBId.toString()}/achievements`)
      .expect(403);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });
});

/** 清成果与它上游的表（实体表走 includingDeleted，同步层走 syncWrite） */
async function clearAchievementTables(prisma: PrismaService): Promise<void> {
  await prisma.includingDeleted.achievement.deleteMany({});
  await prisma.includingDeleted.studentReview.deleteMany({});
  await prisma.includingDeleted.assessmentAppeal.deleteMany({});
  await prisma.includingDeleted.assessment.deleteMany({});
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
