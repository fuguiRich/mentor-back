import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../../common/constants/error-code';
import { BusinessException } from '../../common/errors/business.exception';
import {
  ASSESSMENT_PERIOD_PATTERN,
  LEGACY_ASSESSMENT_PERIOD_PATTERN,
  safeTargetCount,
  type ResolvedWeights,
} from './assessment.constants';
import type { MetricsSource } from './assessment.repository';

/** 一个考核周期的全部指标（提交初评时整组冻结，R55） */
export interface AssessmentMetrics {
  /** 学生评价均分（0-5）；无评价为 null */
  reviewAvg: number | null;
  reviewCount: number;
  guidanceCount: number;
  guidanceMinutes: number;
  studentCount: number;
  achievementCount: number;
  /** 加权总分（百分制），2 位小数 */
  compositeScore: number;
}

/** 打分用的两个目标值（`SysConfig`，R49） */
export interface MetricTargets {
  workloadTargetCount: number;
  achievementTargetCount: number;
}

/**
 * `period` → 半开区间（P5 起按学期，P5-R5）。
 *
 * - `YYYY-1` → `[YYYY-01-01, YYYY-07-01)`
 * - `YYYY-2` → `[YYYY-07-01, (YYYY+1)-01-01)`
 * - `YYYY`（历史四位年份）→ `[YYYY-01-01, (YYYY+1)-01-01)`，只读兼容
 *
 * 学期边界是**自然年上下半年**，不推断校历；要改只改这里。
 * DTO 已经校验过一次，这里再校验是因为这个函数也被「拿历史 period 重算」
 * 的路径调用，不能指望调用方都过了 DTO。
 */
export function periodRange(period: string): { from: Date; to: Date } {
  if (LEGACY_ASSESSMENT_PERIOD_PATTERN.test(period)) {
    const year = Number(period);
    return {
      from: new Date(Date.UTC(year, 0, 1)),
      to: new Date(Date.UTC(year + 1, 0, 1)),
    };
  }
  if (!ASSESSMENT_PERIOD_PATTERN.test(period)) {
    throw new BusinessException(
      ErrorCode.PARAM_INVALID,
      '考核周期必须是 YYYY-S（S=1/2）',
      HttpStatus.BAD_REQUEST,
    );
  }
  const year = Number(period.slice(0, 4));
  const semester = Number(period.slice(5));
  return semester === 1
    ? {
        from: new Date(Date.UTC(year, 0, 1)),
        to: new Date(Date.UTC(year, 6, 1)),
      }
    : {
        from: new Date(Date.UTC(year, 6, 1)),
        to: new Date(Date.UTC(year + 1, 0, 1)),
      };
}

/**
 * 评价分 → 百分制：`avg × 20`。
 *
 * **无评价时是 0，不是 100**——「没人评」不能换来满分。这也是为什么
 * `reviewAvg` 本身保留 `null` 而不在这里丢掉：响应要能让前端区分
 * 「没评价」与「评价很差」。
 */
export function scoreReview(avg: number | null): number {
  return avg === null ? 0 : round2(avg * 20);
}

/** 工作量分：`min(100, count × 100 / target)`；目标值 ≤ 0 按 1 处理（避免除零） */
export function scoreWorkload(count: number, target: number): number {
  return Math.min(100, round2((count * 100) / safeTargetCount(target)));
}

/** 成果分：同工作量口径 */
export function scoreAchievement(count: number, target: number): number {
  return Math.min(100, round2((count * 100) / safeTargetCount(target)));
}

/**
 * 加权总分。权重已由 `resolveWeights` 归一化，这里不再校验和。
 * 三项各自封顶 100，所以结果也必然落在 `[0, 100]`。
 */
export function composeScore(
  parts: { review: number; workload: number; achievement: number },
  weights: ResolvedWeights,
): number {
  return round2(
    parts.review * weights.review +
      parts.workload * weights.workload +
      parts.achievement * weights.achievement,
  );
}

/**
 * 取一个导师一个周期的全部指标（Task 38 的核心）。
 *
 * 只读：不写任何表。提交初评时由 `AssessmentService` 调它一次，把结果整组
 * 冻结进 `assessment` 行（R55）；`status = 0` 时 `GET` 也调它做实时试算。
 *
 * 依赖注入的是 `MetricsSource` 接口而不是 Prisma，所以单测可以用桩喂
 * 「无评价」「目标值为 0」「空集」这些边界，不必起库。
 */
export async function computeMetrics(
  source: MetricsSource,
  mentorId: bigint,
  period: string,
  weights: ResolvedWeights,
  targets: MetricTargets,
): Promise<AssessmentMetrics> {
  const { from, to } = periodRange(period);

  const [review, guidance, achievementCount] = await Promise.all([
    source.tallyReviews(mentorId, from, to),
    source.tallyGuidance(mentorId, from, to),
    source.tallyAchievements(mentorId, from, to),
  ]);

  const reviewScore = scoreReview(review.avg);
  const workloadScore = scoreWorkload(
    guidance.count,
    targets.workloadTargetCount,
  );
  const achievementScore = scoreAchievement(
    achievementCount,
    targets.achievementTargetCount,
  );

  return {
    reviewAvg: review.avg === null ? null : round2(review.avg),
    reviewCount: review.count,
    guidanceCount: guidance.count,
    guidanceMinutes: guidance.minutes,
    studentCount: guidance.students,
    achievementCount,
    compositeScore: composeScore(
      {
        review: reviewScore,
        workload: workloadScore,
        achievement: achievementScore,
      },
      weights,
    ),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
