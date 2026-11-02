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
 * P3 Task 33：`student_review` 的 5 个业务列 + DB-11 唯一键。
 *
 * 这三条都不经过 HTTP——本任务只落表，接口在 Task 34。
 *
 * 1. **唯一键挡重复**：同一 `appointmentId` 两条未删行 → 第二条 `P2002`。
 *    没有这条，`POST /appointments/:id/review` 重复提交就会落两行，
 *    而汇总接口的 `avg` 会被同一条预约的评价重复计入。
 * 2. **软删后可再插**：生成列在 `deleted_at` 非空时取 NULL，唯一键不约束 NULL。
 *    这是「软删表上的唯一约束」与「物理删表」唯一真正的区别，必须单独钉住。
 * 3. **迁移纯增量**：正文里不许出现 `DROP TABLE` / `DROP COLUMN` / `TRUNCATE` / 独立的 `DELETE`。
 *    这条是给「以后有人手滑改迁移」留的闸——迁移一旦应用过，破坏性 DDL 就是不可回滚的。
 */
describe('学生评价表：唯一键与迁移形态（P3 Task 33）(e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let appointmentId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);

    await clearReviewAndUpstream(prisma);
    await clearBusinessTables(prisma);
    await clearModuleTables(prisma);

    const admin = await seedSuperAdmin(prisma);
    const rootDept = await prisma.client.sysDept.findFirst({
      where: { name: '总公司' },
    });
    if (rootDept === null) {
      throw new Error('seedSuperAdmin 未种出「总公司」部门');
    }

    // 评价的外键链：SyncOrgUnit → SyncPerson → MentorProfile → Appointment。
    // 同步层的两张表只有同步任务能写（SYNC_WRITE_FORBIDDEN），造数走 runWithSyncWrite。
    const org = await runWithSyncWrite(() =>
      prisma.client.syncOrgUnit.create({
        data: {
          code: 'ORG-REVIEW-TEST',
          name: '评价测试学院',
          kind: 'college',
          deptId: rootDept.id,
          syncedAt: SYNCED_AT,
          createdBy: 0n,
          updatedBy: 0n,
        },
      }),
    );

    const student = await runWithSyncWrite(() =>
      prisma.client.syncPerson.create({
        data: {
          login: 'review-student',
          realName: '评价学生',
          personType: 'student',
          orgUnitId: org.id,
          syncedAt: SYNCED_AT,
          createdBy: 0n,
          updatedBy: 0n,
        },
      }),
    );

    const mentor = await runWithSyncWrite(() =>
      prisma.client.syncPerson.create({
        data: {
          login: 'review-mentor',
          realName: '评价导师',
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
        personId: mentor.id,
        researchFields: ['创新创业'],
        status: 2,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });

    const appointment = await prisma.client.appointment.create({
      data: {
        studentPersonId: student.id,
        mentorProfileId: profile.id,
        type: 1,
        status: 4,
        requestedTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
        topic: '唯一键用例的预约',
        questions: '这条预约只用于验证评价表的唯一约束',
        mode: 1,
        createdBy: admin.userId,
        updatedBy: admin.userId,
      },
    });
    appointmentId = appointment.id;
  });

  afterAll(async () => {
    try {
      if (prisma !== undefined) {
        await clearReviewAndUpstream(prisma);
        await clearBusinessTables(prisma);
        await clearModuleTables(prisma);
      }
    } finally {
      if (app !== undefined) {
        await app.close();
      }
    }
  });

  function reviewData(attitude: number, comment: string | null) {
    return {
      appointmentId,
      attitude,
      expertise: 4,
      effect: 4,
      overallScore: '4.33',
      comment,
      createdBy: 0n,
      updatedBy: 0n,
    };
  }

  it('判据 1：同一预约插两条未删评价 → 第二条被唯一键挡下（P2002）', async () => {
    const first = await prisma.client.studentReview.create({
      data: reviewData(5, '第一次评价'),
    });
    expect(first.id).toBeGreaterThan(0n);
    expect(first.overallScore.toString()).toBe('4.33');

    // 断言的是**数据库**拒绝，不是服务层预检——本任务还没有服务层
    await expect(
      prisma.client.studentReview.create({ data: reviewData(4, null) }),
    ).rejects.toMatchObject({ code: 'P2002' });

    const rows = await prisma.client.studentReview.findMany({
      where: { appointmentId },
    });
    expect(rows).toHaveLength(1);
  });

  it('判据 2：软删第一条后，同一预约可再插一条', async () => {
    const existing = await prisma.client.studentReview.findFirst({
      where: { appointmentId },
    });
    if (existing === null) {
      throw new Error('判据 1 的评价行不见了');
    }

    // 软删走显式 update（扩展的 delete 对软删表是直接拒绝的，见 R24）
    await prisma.client.studentReview.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), deletedBy: 0n },
    });

    const again = await prisma.client.studentReview.create({
      data: reviewData(3, '软删后重新评价'),
    });
    expect(again.id).not.toBe(existing.id);

    // 读路径看不到软删行（StudentReview 已登记进 SOFT_DELETE_MODELS）
    const visible = await prisma.client.studentReview.findMany({
      where: { appointmentId },
    });
    expect(visible).toHaveLength(1);
    expect(visible[0].id).toBe(again.id);

    // 但库里确实是两行——软删不是物理删
    const all = await prisma.includingDeleted.studentReview.findMany({
      where: { appointmentId },
    });
    expect(all).toHaveLength(2);
  });

  it('判据 3：迁移正文里没有任何破坏性 DDL', () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        'prisma/migrations/20261031090000_add_student_review_fields/migration.sql',
      ),
      'utf8',
    );

    // 去掉 `--` 行注释再判：注释里写「不许 DROP」不算违规
    const body = sql
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');

    expect(body).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(body).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(body).not.toMatch(/\bTRUNCATE\b/i);
    expect(body).not.toMatch(/\bDELETE\s+FROM\b/i);
    // 反向断言：这条迁移确实做了它该做的事，否则上面四条对空文件也成立
    expect(body).toMatch(/ADD\s+COLUMN\s+`attitude`/i);
    expect(body).toMatch(/uk_student_review_appointment_active/i);
  });
});

/**
 * 清掉评价与它上游的预约域 / 同步层表，按外键拓扑序。
 *
 * 实体表走 `includingDeleted`（走 client 会被软删扩展拒绝），
 * 同步层的表必须包在 `runWithSyncWrite` 里（否则 SYNC_WRITE_FORBIDDEN）。
 */
async function clearReviewAndUpstream(prisma: PrismaService): Promise<void> {
  await prisma.includingDeleted.studentReview.deleteMany({});
  await prisma.includingDeleted.assessmentAppeal.deleteMany({});
  await prisma.includingDeleted.assessment.deleteMany({});
  await prisma.includingDeleted.guidanceMaterial.deleteMany({});
  await prisma.includingDeleted.guidanceRecord.deleteMany({});
  await prisma.includingDeleted.appointmentMaterial.deleteMany({});
  await prisma.includingDeleted.appointment.deleteMany({});
  await prisma.includingDeleted.mentorTimeSlot.deleteMany({});
  await prisma.includingDeleted.achievement.deleteMany({});
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
