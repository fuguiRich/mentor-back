import { Injectable } from '@nestjs/common';
import type { MentorProfile, StudentReview, SyncPerson } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { APPOINTMENT_STATUS } from '../appointment/dto/create-appointment.dto';

/** 写入用的评价字段（`overallScore` 已由 Service 算好，见 R41） */
export interface ReviewWrite {
  attitude: number;
  expertise: number;
  effect: number;
  overallScore: string;
  comment: string | null;
}

/** 某导师的评价聚合（Prisma 的 `_avg` 是 Decimal，原样带出，转换在 Service） */
export interface ReviewAggregate {
  count: number;
  overallAvg: { toString(): string } | null;
  attitudeAvg: { toString(): string } | null;
  expertiseAvg: { toString(): string } | null;
  effectAvg: { toString(): string } | null;
}

/**
 * 评价域的数据访问（P3 Task 34）。
 *
 * 只写 `student_review`；`appointment` 上唯一的写是 `4 → 6` 那一跳，
 * 且**与评价插入在同一事务**——分开写会出现「评价落了、预约还停在 4」，
 * 下一次评价就会被唯一键挡成 409，而那条预约永远等不到 `6`。
 *
 * 读 `sync_person` / `mentor_profile` 只为身份链与导师存在性，不写它们。
 */
@Injectable()
export class ReviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByAppointmentId(appointmentId: bigint): Promise<StudentReview | null> {
    return this.prisma.client.studentReview.findFirst({
      where: { appointmentId },
    });
  }

  /**
   * 写评价 + 预约 `4 STUDENT_CONFIRMED → 6 COMPLETED`，**同一事务**。
   *
   * 先做条件更新：`count === 0` 说明状态已经不是 `4`（并发的第二个请求先到了），
   * 直接返回 `null` 让调用方抛 409 / 34003——此时**还没有插评价**，不需要补偿。
   * 插评价若撞唯一键（P2002），整个事务回滚，预约仍停在 `4`。
   */
  async createWithTransition(
    appointmentId: bigint,
    input: ReviewWrite,
  ): Promise<StudentReview | null> {
    return this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.appointment.updateMany({
        where: {
          id: appointmentId,
          status: APPOINTMENT_STATUS.STUDENT_CONFIRMED,
        },
        data: { status: APPOINTMENT_STATUS.COMPLETED },
      });
      if (updated.count === 0) {
        return null;
      }
      return tx.studentReview.create({
        // createdBy / updatedBy 是类型占位，扩展按当前操作者重写（DB-05）
        data: { appointmentId, ...input, createdBy: 0n, updatedBy: 0n },
      });
    });
  }

  async findPageByMentorProfile(
    mentorProfileId: bigint,
    skip: number,
    take: number,
  ): Promise<[StudentReview[], number]> {
    const where = { appointment: { mentorProfileId } };
    return Promise.all([
      this.prisma.client.studentReview.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.client.studentReview.count({ where }),
    ]);
  }

  /**
   * 某导师的评价汇总（**全量口径**，与分页无关）。
   *
   * `_avg` 在没有行时返回 `null`（不是 0），正好对应响应里「无评价 → 均值 null」的契约，
   * 不要在 Service 里把 `null` 兜成 0。
   */
  async aggregateByMentorProfile(
    mentorProfileId: bigint,
  ): Promise<ReviewAggregate> {
    const result = await this.prisma.client.studentReview.aggregate({
      where: { appointment: { mentorProfileId } },
      _count: { _all: true },
      _avg: {
        overallScore: true,
        attitude: true,
        expertise: true,
        effect: true,
      },
    });
    return {
      count: result._count._all,
      overallAvg: result._avg.overallScore,
      attitudeAvg: result._avg.attitude,
      expertiseAvg: result._avg.expertise,
      effectAvg: result._avg.effect,
    };
  }

  /** 身份链第 2 步：`SysUser.username` → `SyncPerson.login`（自然键，无外键） */
  findPersonByLogin(login: string): Promise<SyncPerson | null> {
    return this.prisma.client.syncPerson.findFirst({ where: { login } });
  }

  findProfileById(id: bigint): Promise<MentorProfile | null> {
    return this.prisma.client.mentorProfile.findFirst({ where: { id } });
  }

  findProfileByPersonId(personId: bigint): Promise<MentorProfile | null> {
    return this.prisma.client.mentorProfile.findFirst({ where: { personId } });
  }
}
