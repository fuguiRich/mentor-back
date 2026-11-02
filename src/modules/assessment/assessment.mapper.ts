import type { Assessment, AssessmentAppeal } from '@prisma/client';
import type { ResolvedWeights } from './assessment.constants';
import type { AssessmentMetrics } from './assessment.metrics';
import type { AppealResponseDto } from './dto/appeal-response.dto';
import type { AssessmentResponseDto } from './dto/assessment-response.dto';

function numberToString(value: number): string {
  return value.toFixed(2);
}

/**
 * 实体 + 指标 + 权重 → 响应 DTO（RES-04：显式映射）。
 *
 * 指标与权重**由调用方传入**：`status = 0` 传实时试算值，`status ≥ 1` 传冻结值
 * （R55）。放在这里做分支会把「什么时候冻结」藏进 mapper，而那是 Service 的决定。
 */
export function toAssessmentResponse(
  row: Assessment,
  metrics: AssessmentMetrics,
  weights: ResolvedWeights,
): AssessmentResponseDto {
  return {
    id: row.id.toString(),
    mentorProfileId: row.mentorId.toString(),
    period: row.period,
    status: row.status,
    weights: {
      review: weights.review,
      workload: weights.workload,
      achievement: weights.achievement,
      normalized: weights.normalized,
    },
    metrics: {
      reviewAvg:
        metrics.reviewAvg === null ? null : numberToString(metrics.reviewAvg),
      reviewCount: metrics.reviewCount,
      guidanceCount: metrics.guidanceCount,
      guidanceMinutes: metrics.guidanceMinutes,
      studentCount: metrics.studentCount,
      achievementCount: metrics.achievementCount,
      compositeScore: numberToString(metrics.compositeScore),
    },
    collegeGrade: row.collegeGrade,
    collegeComment: row.collegeComment,
    collegeSubmittedAt:
      row.collegeSubmittedAt === null
        ? null
        : row.collegeSubmittedAt.toISOString(),
    finalGrade: row.finalGrade,
    finalComment: row.finalComment,
    finalReviewedAt:
      row.finalReviewedAt === null ? null : row.finalReviewedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * 冻结在行上的指标 → `AssessmentMetrics`。
 *
 * 只有 `status ≥ 1` 的行才该走这里——那时 6 个指标列 + `compositeScore`
 * 都已落库，不会是 null。真遇到 null（数据被手工改过）就按 0 / null 处理，
 * 不抛：读接口不该因为一行脏数据整个 500。
 */
export function frozenMetrics(row: Assessment): AssessmentMetrics {
  return {
    reviewAvg: row.reviewAvg === null ? null : Number(row.reviewAvg),
    reviewCount: row.reviewCount ?? 0,
    guidanceCount: row.guidanceCount ?? 0,
    guidanceMinutes: row.guidanceMinutes ?? 0,
    studentCount: row.studentCount ?? 0,
    achievementCount: row.achievementCount ?? 0,
    compositeScore:
      row.compositeScore === null ? 0 : Number(row.compositeScore),
  };
}

/**
 * 冻结在行上的权重 → `ResolvedWeights`。
 *
 * `weights` 列是提交初评时写进去的 JSON。缺字段时回落到默认权重并置
 * `normalized = true`——让「这行数据不完整」在响应里看得见，而不是静默用 0。
 */
export function frozenWeights(
  row: Assessment,
  fallback: ResolvedWeights,
): ResolvedWeights {
  const raw = row.weights;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...fallback, normalized: true };
  }
  const record = raw as Record<string, unknown>;
  const read = (key: string, or: number): number => {
    const value = record[key];
    return typeof value === 'number' ? value : or;
  };
  return {
    review: read('review', fallback.review),
    workload: read('workload', fallback.workload),
    achievement: read('achievement', fallback.achievement),
    normalized: record.normalized === true,
  };
}

/** 申诉实体 → 响应 DTO（RES-04） */
export function toAppealResponse(row: AssessmentAppeal): AppealResponseDto {
  return {
    id: row.id.toString(),
    assessmentId: row.assessmentId.toString(),
    reason: row.reason,
    status: row.status,
    reply: row.reply,
    handledAt: row.handledAt === null ? null : row.handledAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
