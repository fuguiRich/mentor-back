import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { runWithSyncWrite } from '../src/infra/prisma/sync-write-scope';
import { ErrorCode } from '../src/common/constants/error-code';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import { currentPeriod } from '../src/modules/assessment/assessment.constants';
import type { AssessmentResponseDto } from '../src/modules/assessment/dto/assessment-response.dto';
import type { AssessmentRuleResponseDto } from '../src/modules/assessment/dto/assessment-rule.dto';
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
 * §6.6 考核评分规则配置（P5 Task 57）。
 *
 * 权重 / 目标值读 `SysConfig`；`PUT` 是类型化入口，必须把「用户输入错误」
 * 挡成 400，而不是让 `resolveWeights` 的配置错误（500）漏出来。
 */
describe('考核评分规则配置（P5 Task 57 / §6.6）(e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const agents = new Map<string, E2eApi>();
  const permissionIds = new Map<string, bigint>();
  const deptIds = new Map<string, bigint>();
  let mentorProfileId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);

    await clearRuleTables(prisma);
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
    deptIds.set('A', await createDept('规则 A 学院', rootDept.id));

    const org = await runWithSyncWrite(() =>
      prisma.client.syncOrgUnit.create({
        data: {
          code: 'ORG-RULE-A',
          name: '规则 A 组织',
          kind: 'college',
          deptId: dept('A'),
          syncedAt: SYNCED_AT,
          createdBy: 0n,
          updatedBy: 0n,
        },
      }),
    );
    const person = await runWithSyncWrite(() =>
      prisma.client.syncPerson.create({
        data: {
          login: 'rule-mentor',
          realName: 'rule-mentor',
          personType: 'internalMentor',
          orgUnitId: org.id,
          syncedAt: SYNCED_AT,
          createdBy: 0n,
          updatedBy: 0n,
        },
      }),
    );
    mentorProfileId = (
      await prisma.client.mentorProfile.create({
        data: {
          personId: person.id,
          researchFields: ['人工智能'],
          status: 2,
          createdBy: 0n,
          updatedBy: 0n,
        },
      })
    ).id;

    const scRole = await createRole('规则双创学院', 'rule_sc', 'all', [
      'assessment:list',
      'assessment:evaluate',
      'assessment:rule-manage',
    ]);
    const collegeRole = await createRole(
      '规则学院管理员',
      'rule_college',
      'dept',
      ['assessment:list'],
    );

    for (const [username, roleId, deptKey] of [
      ['rule-sc', scRole, 'root'],
      ['rule-college', collegeRole, 'A'],
    ] as const) {
      const user = await seedUser(prisma, { username, deptId: dept(deptKey) });
      await prisma.client.sysUserRole.create({
        data: { userId: user.userId, roleId, createdBy: 0n, updatedBy: 0n },
      });
      const tokens = await loginAs(app, username, 'Passw0rd!');
      agents.set(username, authedAgent(app, tokens.accessToken));
    }
  });

  afterAll(async () => {
    try {
      if (prisma !== undefined) {
        await clearRuleTables(prisma);
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

  async function ensurePermissionId(code: string): Promise<bigint> {
    const cached = permissionIds.get(code);
    if (cached !== undefined) {
      return cached;
    }
    const row = await prisma.client.sysPermission.create({
      data: {
        type: 'BUTTON',
        code,
        name: `P5 ${code}`,
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

  it('判据 1：GET 规则 → 默认 0.4 / 0.4 / 0.2、目标 10 / 5', async () => {
    const response = await api('rule-sc').get('/assessments/rules').expect(200);
    const data = (response.body as ResponseEnvelope<AssessmentRuleResponseDto>)
      .data;

    expect(data.weights).toEqual({
      review: 0.4,
      workload: 0.4,
      achievement: 0.2,
      normalized: false,
    });
    expect(data.targets).toEqual({ workload: 10, achievement: 5 });
  });

  it('判据 2：PUT 规则 → 写 SysConfig 并回显', async () => {
    const response = await api('rule-sc')
      .put('/assessments/rules')
      .send({
        weights: { review: 0.5, workload: 0.3, achievement: 0.2 },
        targets: { workload: 20, achievement: 10 },
      })
      .expect(200);
    const data = (response.body as ResponseEnvelope<AssessmentRuleResponseDto>)
      .data;

    expect(data.weights).toEqual({
      review: 0.5,
      workload: 0.3,
      achievement: 0.2,
      normalized: false,
    });
    expect(data.targets).toEqual({ workload: 20, achievement: 10 });

    const rows = await prisma.client.sysConfig.findMany({
      where: { code: { startsWith: 'assessment.' } },
    });
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.valueType).toBe('number');
      expect(row.status).toBe(1);
    }
  });

  it('判据 3：和不为 1 → 归一化并回显 normalized=true', async () => {
    const response = await api('rule-sc')
      .put('/assessments/rules')
      .send({ weights: { review: 1, workload: 1, achievement: 0 } })
      .expect(200);
    const data = (response.body as ResponseEnvelope<AssessmentRuleResponseDto>)
      .data;

    expect(data.weights).toEqual({
      review: 0.5,
      workload: 0.5,
      achievement: 0,
      normalized: true,
    });
  });

  it('判据 4：权重全 0 / 负数 → 400 / 10001', async () => {
    for (const weights of [
      { review: 0, workload: 0, achievement: 0 },
      { review: -1, workload: 1, achievement: 0 },
    ]) {
      const response = await api('rule-sc')
        .put('/assessments/rules')
        .send({ weights })
        .expect(400);
      expect((response.body as ResponseEnvelope<null>).code).toBe(
        ErrorCode.PARAM_INVALID,
      );
    }
  });

  it('判据 5：目标值 0 → 400 / 10001', async () => {
    const response = await api('rule-sc')
      .put('/assessments/rules')
      .send({
        weights: { review: 0.4, workload: 0.4, achievement: 0.2 },
        targets: { workload: 0 },
      })
      .expect(400);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PARAM_INVALID,
    );
  });

  it('判据 6：学院管理员 PUT → 403 / 10003', async () => {
    const response = await api('rule-college')
      .put('/assessments/rules')
      .send({ weights: { review: 1, workload: 0, achievement: 0 } })
      .expect(403);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  it('判据 7：新建考核冻结的是当前配置的权重', async () => {
    const response = await api('rule-sc')
      .post('/assessments')
      .send({
        mentorId: mentorProfileId.toString(),
        period: currentPeriod(),
      })
      .expect(201);
    const data = (response.body as ResponseEnvelope<AssessmentResponseDto>)
      .data;

    expect(data.weights).toEqual({
      review: 0.5,
      workload: 0.5,
      achievement: 0,
      normalized: true,
    });
  });
});

async function clearRuleTables(prisma: PrismaService): Promise<void> {
  await prisma.includingDeleted.archiveItem.deleteMany({});
  await prisma.includingDeleted.assessmentAppeal.deleteMany({});
  await prisma.includingDeleted.assessment.deleteMany({});
  await prisma.includingDeleted.achievement.deleteMany({});
  await prisma.includingDeleted.studentReview.deleteMany({});
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
