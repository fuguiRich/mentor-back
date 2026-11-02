import type { StudentReview } from '@prisma/client';
import type {
  ReviewResponseDto,
  ReviewSummaryDto,
} from './dto/review-response.dto';
import type { ReviewAggregate } from './review.repository';

/**
 * 实体 → 响应 DTO（RES-04：显式映射）。
 *
 * `mentorProfileId` 不在 `student_review` 表上——它是评价所属**预约**的导师。
 * 由调用方带进来：单条读取时来自预约实体，列表读取时就是查询条件本身。
 * 不在 DTO 里丢掉它，是因为前端拿一条评价后要能跳到导师主页。
 */
export function toReviewResponse(
  row: StudentReview,
  mentorProfileId: bigint,
): ReviewResponseDto {
  return {
    id: row.id.toString(),
    appointmentId: row.appointmentId.toString(),
    mentorProfileId: mentorProfileId.toString(),
    attitude: row.attitude,
    expertise: row.expertise,
    effect: row.effect,
    overallScore: toFixed2(row.overallScore),
    comment: row.comment,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * 聚合 → 汇总 DTO。
 *
 * 均值一律 **2 位小数**；`count = 0` 时四个均值是 `null`，**不是 0**——
 * 「没人评」与「评了 0 分」在业务上是相反的事实，报表上混成一个数就再也分不开。
 */
export function toReviewSummary(agg: ReviewAggregate): ReviewSummaryDto {
  return {
    count: agg.count,
    avg: agg.overallAvg === null ? null : round2(Number(agg.overallAvg)),
    attitudeAvg:
      agg.attitudeAvg === null ? null : round2(Number(agg.attitudeAvg)),
    expertiseAvg:
      agg.expertiseAvg === null ? null : round2(Number(agg.expertiseAvg)),
    effectAvg: agg.effectAvg === null ? null : round2(Number(agg.effectAvg)),
  };
}

/** `Decimal` → `"4.33"`（DECIMAL 对外一律字符串，见 ReviewResponseDto 的说明） */
export function toFixed2(value: { toString(): string }): string {
  return round2(Number(value)).toFixed(2);
}

/** 保留 2 位小数（四舍五入）。评价只有 1-5 分，不会溢出 Decimal(3,2) */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
