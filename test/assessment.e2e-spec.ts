import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { runWithSyncWrite } from '../src/infra/prisma/sync-write-scope';
import {
  clearBusinessTables,
  clearModuleTables,
  seedSuperAdmin,
} from './e2e-helpers';

const SYNCED_AT = new Date('2026-10-27T00:00:00.000Z');

/**
 * P3 Task 37：`assessment` 的 18 个业务列 + DB-11 复合生成列唯一键。
 *
 * 三条判据都不经过 HTTP——本任务只落表，接口在 Task 39 之后。
 * 接口层的用例在 `assessment-flow.e2e-spec.ts`（Task 44 的验收）里。
 */
describe('考核表：复合唯一键与迁移形态（P3 Task 37）(e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mentorId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);

    await clearAssessmentTables(prisma);
    await clearBusinessTables(prisma);
    await clearModuleTables(prisma);

    const admin = await seedSuperAdmin(prisma);
    const rootDept = await prisma.client.sysDept.findFirst({
      where: { name: '总公司' },
    });
    if (rootDept === null) {
      throw new Error('seedSuperAdmin 未种出「总公司」部门');
    }

    const org = await runWithSyncWrite(() =>
      prisma.client.syncOrgUnit.create({
        data: {
          code: 'ORG-ASSESS-TEST',
          name: '考核测试学院',
          kind: 'college',
          deptId: rootDept.id,
          syncedAt: SYNCED_AT,
          createdBy: 0n,
          updatedBy: 0n,
        },
      }),
    );
    const person = await runWithSyncWrite(() =>
      prisma.client.syncPerson.create({
        data: {
          login: 'assess-mentor',
          realName: '考核导师',
          personType: 'internalMentor',
          orgUnitId: org.id,
          syncedAt: SYNCED_AT,
          createdBy: 0n,
          updatedBy: 0n,
        },
      }),
    );
    const profile = await prisma.client.mentorProfile.create({
      data: {
        personId: person.id,
        researchFields: ['创新创业'],
        status: 2,
        createdBy: admin.userId,
        updatedBy: admin.userId,
      },
    });
    mentorId = profile.id;
  });

  afterAll(async () => {
    try {
      if (prisma !== undefined) {
        await clearAssessmentTables(prisma);
        await clearBusinessTables(prisma);
        await clearModuleTables(prisma);
      }
    } finally {
      if (app !== undefined) {
        await app.close();
      }
    }
  });

  function assessmentData(period: string) {
    return {
      mentorId,
      period,
      createdBy: 0n,
      updatedBy: 0n,
    };
  }

  it('判据 1：同一导师同一周期插两条 → 第二条被唯一键挡下（P2002）', async () => {
    const first = await prisma.client.assessment.create({
      data: assessmentData('2026'),
    });
    expect(first.status).toBe(0);
    // 未提交时指标列全为 null（还没冻结，R55）
    expect(first.reviewAvg).toBeNull();
    expect(first.compositeScore).toBeNull();
    expect(first.weights).toBeNull();

    await expect(
      prisma.client.assessment.create({ data: assessmentData('2026') }),
    ).rejects.toMatchObject({ code: 'P2002' });

    const rows = await prisma.client.assessment.findMany({
      where: { mentorId, period: '2026' },
    });
    expect(rows).toHaveLength(1);
  });

  it('判据 2：换一个周期可以再建；软删后同一周期也可再建', async () => {
    // 不同周期不冲突
    const other = await prisma.client.assessment.create({
      data: assessmentData('2025'),
    });
    expect(other.period).toBe('2025');

    // 软删 2026 那条后，同一周期可再建（生成列在 deleted_at 非空时取 NULL）
    const existing = await prisma.client.assessment.findFirst({
      where: { mentorId, period: '2026' },
    });
    if (existing === null) {
      throw new Error('判据 1 的考核行不见了');
    }
    await prisma.client.assessment.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), deletedBy: 0n },
    });

    const again = await prisma.client.assessment.create({
      data: assessmentData('2026'),
    });
    expect(again.id).not.toBe(existing.id);

    const visible = await prisma.client.assessment.findMany({
      where: { mentorId, period: '2026' },
    });
    expect(visible).toHaveLength(1);
    expect(visible[0].id).toBe(again.id);

    const all = await prisma.includingDeleted.assessment.findMany({
      where: { mentorId, period: '2026' },
    });
    expect(all).toHaveLength(2);
  });

  it('判据 3：迁移正文里没有任何破坏性 DDL', () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        'prisma/migrations/20261101090000_add_assessment_fields/migration.sql',
      ),
      'utf8',
    );
    const body = sql
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');

    expect(body).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(body).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(body).not.toMatch(/\bTRUNCATE\b/i);
    expect(body).not.toMatch(/\bDELETE\s+FROM\b/i);
    // 反向断言：迁移确实做了它该做的事，否则上面四条对空文件也成立
    expect(body).toMatch(/ADD\s+COLUMN\s+`period`/i);
    expect(body).toMatch(/uk_assessment_mentor_period_active/i);
    expect(body).toMatch(/ADD\s+COLUMN\s+`reason`/i);
  });
});

/** 清考核与它上游的表（实体表走 includingDeleted，同步层走 syncWrite） */
async function clearAssessmentTables(prisma: PrismaService): Promise<void> {
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
