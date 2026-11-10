import { Injectable } from '@nestjs/common';
import type {
  Assessment,
  AssessmentAppeal,
  MentorProfile,
  Prisma,
  SyncPerson,
} from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { APPOINTMENT_STATUS } from '../appointment/dto/create-appointment.dto';
import { APPEAL_STATUS, ASSESSMENT_STATUS } from './assessment.constants';

/** 评价维度：条数 + 均分（均分无评价时为 null，不是 0） */
export interface ReviewTally {
  count: number;
  avg: number | null;
}

/** 指导工作量：次数 / 分钟数 / 去重学生数 */
export interface GuidanceTally {
  count: number;
  minutes: number;
  students: number;
}

/**
 * 指标聚合的**数据源**接口（P3 Task 38）。
 *
 * `assessment.metrics.ts` 只依赖这个接口，不依赖 Prisma——纯函数才能被单测
 * 用桩直接喂边界值（无评价、目标值为 0、空集）。
 */
export interface MetricsSource {
  tallyReviews(mentorId: bigint, from: Date, to: Date): Promise<ReviewTally>;
  tallyGuidance(mentorId: bigint, from: Date, to: Date): Promise<GuidanceTally>;
  tallyAchievements(mentorId: bigint, from: Date, to: Date): Promise<number>;
}

/** 考核 + 导师 + 导师所在组织单元（部门范围判定用） */
export type AssessmentWithMentor = Assessment & {
  mentor: MentorProfile & {
    person: SyncPerson & {
      orgUnit: { deptId: bigint | null; name: string } | null;
    };
  };
};

/** 导师档案 + 其人的组织单元（`POST /assessments` 的部门判定用） */
export type ProfileWithDept = MentorProfile & {
  person: SyncPerson & {
    orgUnit: { deptId: bigint | null; name: string } | null;
  };
};

/** 提交初评时要冻结的整组数据（R55） */
export interface CollegeReviewWrite {
  status: number;
  weights: {
    review: number;
    workload: number;
    achievement: number;
    normalized: boolean;
  };
  reviewAvg: string | null;
  reviewCount: number;
  guidanceCount: number;
  guidanceMinutes: number;
  studentCount: number;
  achievementCount: number;
  compositeScore: string;
  collegeGrade: number;
  collegeComment: string;
  collegeSubmittedAt: Date;
  collegeSubmittedBy: bigint;
}

/** 终评要写的整组数据（`return` 时 `finalGrade` 必须是 `null`） */
export interface FinalReviewWrite {
  status: number;
  finalGrade: number | null;
  finalComment: string;
  finalReviewedAt: Date;
  finalReviewedBy: bigint;
}

/**
 * 考核域的数据访问（P3 Task 38 起）。
 *
 * 读聚合：`tallyReviews` / `tallyGuidance` / `tallyAchievements`（口径见
 * `docs/plans/2026-10-30-mentor-p3.md` Task 38 的表）。
 * 写只有 `assessment` / `assessment_appeal` 两张表；评价 / 指导记录 / 成果都只读。
 *
 * 读一律 `findFirst`（软删表塞不进 `deletedAt` 过滤的 `findUnique`）。
 */
@Injectable()
export class AssessmentRepository implements MetricsSource {
  constructor(private readonly prisma: PrismaService) {}

  // ── 指标聚合（Task 38）───────────────────────────────────────────

  async tallyReviews(
    mentorId: bigint,
    from: Date,
    to: Date,
  ): Promise<ReviewTally> {
    const result = await this.prisma.client.studentReview.aggregate({
      where: {
        appointment: { mentorProfileId: mentorId },
        createdAt: { gte: from, lt: to },
      },
      _count: { _all: true },
      _avg: { overallScore: true },
    });
    return {
      count: result._count._all,
      avg:
        result._avg.overallScore === null
          ? null
          : Number(result._avg.overallScore),
    };
  }

  async tallyGuidance(
    mentorId: bigint,
    from: Date,
    to: Date,
  ): Promise<GuidanceTally> {
    const where = {
      appointment: {
        mentorProfileId: mentorId,
        status: APPOINTMENT_STATUS.COMPLETED,
      },
      actualTime: { gte: from, lt: to },
    } as const;

    const [aggregate, students] = await Promise.all([
      this.prisma.client.guidanceRecord.aggregate({
        where,
        _count: { _all: true },
        _sum: { durationMinutes: true },
      }),
      // 去重学生数：同一学生指导 3 次只算 1 人
      this.prisma.client.appointment.findMany({
        where: {
          mentorProfileId: mentorId,
          status: APPOINTMENT_STATUS.COMPLETED,
          guidanceRecords: { some: { actualTime: { gte: from, lt: to } } },
        },
        select: { studentPersonId: true },
        distinct: ['studentPersonId'],
      }),
    ]);

    return {
      count: aggregate._count._all,
      minutes: aggregate._sum.durationMinutes ?? 0,
      students: students.length,
    };
  }

  tallyAchievements(mentorId: bigint, from: Date, to: Date): Promise<number> {
    return this.prisma.client.achievement.count({
      where: { mentorId, awardedAt: { gte: from, lt: to } },
    });
  }

  // ── 写（Task 39 起）───────────────────────────────────────────────

  findById(id: bigint): Promise<Assessment | null> {
    return this.prisma.client.assessment.findFirst({ where: { id } });
  }

  findByMentorPeriod(
    mentorId: bigint,
    period: string,
  ): Promise<Assessment | null> {
    return this.prisma.client.assessment.findFirst({
      where: { mentorId, period },
    });
  }

  create(mentorId: bigint, period: string): Promise<Assessment> {
    return this.prisma.client.assessment.create({
      // createdBy / updatedBy 是类型占位，扩展按当前操作者重写（DB-05）
      data: { mentorId, period, createdBy: 0n, updatedBy: 0n },
    });
  }

  findByIdWithMentor(id: bigint): Promise<AssessmentWithMentor | null> {
    return this.prisma.client.assessment.findFirst({
      where: { id },
      include: {
        mentor: { include: { person: { include: { orgUnit: true } } } },
      },
    });
  }

  findProfileWithDept(id: bigint): Promise<ProfileWithDept | null> {
    return this.prisma.client.mentorProfile.findFirst({
      where: { id },
      include: { person: { include: { orgUnit: true } } },
    });
  }

  /** 身份链第 2 步：`SysUser.username` → `SyncPerson.login`（自然键，无外键） */
  findPersonByLogin(login: string): Promise<SyncPerson | null> {
    return this.prisma.client.syncPerson.findFirst({ where: { login } });
  }

  findPage(
    where: Prisma.AssessmentWhereInput,
    skip: number,
    take: number,
  ): Promise<[AssessmentWithMentor[], number]> {
    return Promise.all([
      this.prisma.client.assessment.findMany({
        where,
        orderBy: [{ period: 'desc' }, { id: 'desc' }],
        skip,
        take,
        include: {
          mentor: { include: { person: { include: { orgUnit: true } } } },
        },
      }),
      this.prisma.client.assessment.count({ where }),
    ]);
  }

  /**
   * 提交初评（Task 39）：**条件更新**（`where { id, status: 出发态 }`）+ 冻结整组指标，同一事务。
   *
   * `count === 0` 说明状态在「读」与「写」之间变了（并发里输掉的一方，
   * 或者终评已经把它推走），返回 `null` 让调用方抛 409 / 35002。
   */
  async submitCollegeReview(
    id: bigint,
    fromStatus: number,
    data: CollegeReviewWrite,
  ): Promise<Assessment | null> {
    return this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.assessment.updateMany({
        where: { id, status: fromStatus },
        data,
      });
      if (updated.count === 0) {
        return null;
      }
      return tx.assessment.findFirst({ where: { id } });
    });
  }

  /**
   * 终评（Task 40）：`1 COLLEGE_SUBMITTED → 2 APPROVED | 3 RETURNED`。
   *
   * 条件更新只认出发态 `1`；`count === 0` → `null`（调用方 409 / 35002）。
   * 退回时 `finalGrade` 必须传 `null`——**不是沿用旧值**：退回表示「这次没定级」。
   *
   * 终评通过时**同一事务**落一条归档（P4 Task 52 / R66）。幂等：已存在未删行
   * 时跳过——数据被手工改过时不该让事务失败。
   */
  async submitFinalReview(
    id: bigint,
    data: FinalReviewWrite,
  ): Promise<Assessment | null> {
    return this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.assessment.updateMany({
        where: { id, status: ASSESSMENT_STATUS.COLLEGE_SUBMITTED },
        data,
      });
      if (updated.count === 0) {
        return null;
      }
      const row = await tx.assessment.findFirst({ where: { id } });

      if (row !== null && data.status === ASSESSMENT_STATUS.APPROVED) {
        const targetId = row.id.toString();
        const existing = await tx.archiveItem.findFirst({
          where: { targetType: 'Assessment', targetId },
        });
        if (existing === null) {
          // 学院快照（R66）：归档要活过导师调岗，检索按当时的部门算
          const mentor = await tx.mentorProfile.findFirst({
            where: { id: row.mentorId },
            select: {
              person: { select: { orgUnit: { select: { deptId: true } } } },
            },
          });
          await tx.archiveItem.create({
            data: {
              targetType: 'Assessment',
              targetId,
              title: `导师考核档案 ${row.period}`,
              mentorId: row.mentorId,
              deptId: mentor?.person.orgUnit?.deptId ?? null,
              category: 'assessment',
              core: 1,
              archivedAt: new Date(),
              createdBy: 0n,
              updatedBy: 0n,
            },
          });
        }
      }

      return row;
    });
  }

  // ── 申诉（Task 42）───────────────────────────────────────────────

  /**
   * 提交申诉：同一事务里把考核 `2 APPROVED → 4 APPEALING` 并落申诉行。
   *
   * 条件更新是并发闸门：同一考核只有一条 `PENDING` 申诉能创建成功；
   * `count === 0` 返回 `null`，调用方按状态冲突处理。
   */
  async createAppealAndMarkAppealing(
    assessmentId: bigint,
    reason: string,
    fileIds: string[],
  ): Promise<AssessmentAppeal | null> {
    return this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.assessment.updateMany({
        where: {
          id: assessmentId,
          status: ASSESSMENT_STATUS.APPROVED,
        },
        data: { status: ASSESSMENT_STATUS.APPEALING },
      });
      if (updated.count === 0) {
        return null;
      }
      return tx.assessmentAppeal.create({
        data: {
          assessmentId,
          reason,
          fileIds,
          createdBy: 0n,
          updatedBy: 0n,
        },
      });
    });
  }

  /** 附件元数据：只回未软删的文件 */
  async findFilesByIds(ids: readonly bigint[]): Promise<
    Array<{
      id: bigint;
      originName: string;
      mimeType: string;
      size: number;
    }>
  > {
    if (ids.length === 0) {
      return [];
    }
    return this.prisma.client.sysFile.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        originName: true,
        mimeType: true,
        size: true,
      },
    });
  }

  findPendingAppeal(assessmentId: bigint): Promise<AssessmentAppeal | null> {
    return this.prisma.client.assessmentAppeal.findFirst({
      where: { assessmentId, status: APPEAL_STATUS.PENDING },
    });
  }

  findAppealsByAssessment(
    assessmentId: bigint,
    skip: number,
    take: number,
  ): Promise<[AssessmentAppeal[], number]> {
    const where = { assessmentId };
    return Promise.all([
      this.prisma.client.assessmentAppeal.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.client.assessmentAppeal.count({ where }),
    ]);
  }

  findAppealById(
    assessmentId: bigint,
    appealId: bigint,
  ): Promise<AssessmentAppeal | null> {
    return this.prisma.client.assessmentAppeal.findFirst({
      where: { id: appealId, assessmentId },
    });
  }

  /**
   * 处理一条申诉：条件更新只认 `status = 0`。
   *
   * `count === 0` → `null`（调用方 409 / 35002）：并发里输掉的一方，
   * 或者这条已经被处理过。
   */
  async handleAppeal(
    assessmentId: bigint,
    appealId: bigint,
    nextAssessmentStatus: number,
    data: {
      status: number;
      reply: string;
      handledAt: Date;
      handledBy: bigint;
    },
  ): Promise<AssessmentAppeal | null> {
    return this.prisma.client.$transaction(async (tx) => {
      const assessmentUpdated = await tx.assessment.updateMany({
        where: {
          id: assessmentId,
          status: ASSESSMENT_STATUS.APPEALING,
        },
        data: { status: nextAssessmentStatus },
      });
      if (assessmentUpdated.count === 0) {
        return null;
      }
      const updated = await tx.assessmentAppeal.updateMany({
        where: { id: appealId, assessmentId, status: APPEAL_STATUS.PENDING },
        data,
      });
      if (updated.count === 0) {
        return null;
      }
      return tx.assessmentAppeal.findFirst({ where: { id: appealId } });
    });
  }

  /** 批量取用户姓名：考核 / 申诉里的 reviewer / handler ID → 姓名 */
  async findUserNamesByIds(
    ids: readonly bigint[],
  ): Promise<Map<string, string>> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.prisma.client.sysUser.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, realName: true },
    });
    return new Map(rows.map((row) => [row.id.toString(), row.realName]));
  }
}
