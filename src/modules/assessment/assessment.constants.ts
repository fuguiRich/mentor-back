import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../../common/constants/error-code';
import { BusinessException } from '../../common/errors/business.exception';

/**
 * 考核状态机（P3 Task 37 / R12 的考核侧）。
 *
 * ```
 * 0 DRAFT              → 1 COLLEGE_SUBMITTED   学院提交初评
 * 1 COLLEGE_SUBMITTED  → 2 APPROVED            双创学院通过
 * 1 COLLEGE_SUBMITTED  → 3 RETURNED            双创学院退回（意见必填）
 * 3 RETURNED           → 1 COLLEGE_SUBMITTED   学院重评后再提交
 * ```
 *
 * **终态**：`2 APPROVED`。`3 RETURNED` 不是终态（可再提交）。
 */
export const ASSESSMENT_STATUS = {
  DRAFT: 0,
  COLLEGE_SUBMITTED: 1,
  APPROVED: 2,
  RETURNED: 3,
} as const;

/** 考核等级：1 优秀 / 2 合格 / 3 不合格（§6.3 的三个档） */
export const ASSESSMENT_GRADES = [1, 2, 3] as const;

export const ASSESSMENT_GRADE_LABELS: Readonly<Record<number, string>> = {
  1: '优秀',
  2: '合格',
  3: '不合格',
};

/** 申诉状态机：`0 PENDING → 1 ACCEPTED | 2 REJECTED`，终态 1 / 2 */
export const APPEAL_STATUS = {
  PENDING: 0,
  ACCEPTED: 1,
  REJECTED: 2,
} as const;

/**
 * 考核周期：`YYYY-S`（S=1/2），P5 起按学期。
 *
 * 学期边界由 `periodRange` 统一定义为**自然年上下半年**（P5-R5）：
 * - `YYYY-1` = `[YYYY-01-01, YYYY-07-01)`
 * - `YYYY-2` = `[YYYY-07-01, (YYYY+1)-01-01)`
 *
 * 校历因校而异，硬编码「9 月开学」等于替每所学校做决定；要改只改这一个函数。
 */
export const ASSESSMENT_PERIOD_PATTERN = /^\d{4}-[12]$/;

/** 历史四位年份（P3 口径）：只读兼容，新写入不收 */
export const LEGACY_ASSESSMENT_PERIOD_PATTERN = /^\d{4}$/;

/** 当前学期（UTC 上半年 → `YYYY-1`，下半年 → `YYYY-2`） */
export function currentPeriod(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  return month <= 6 ? `${year}-1` : `${year}-2`;
}

/** `SysConfig` 键：三个指标权重（§6.6） */
export const WEIGHT_CONFIG_CODES = {
  review: 'assessment.weight.review',
  workload: 'assessment.weight.workload',
  achievement: 'assessment.weight.achievement',
} as const;

/** `SysConfig` 键：工作量 / 成果满分对应的目标值（R49） */
export const WORKLOAD_TARGET_CONFIG_CODE = 'assessment.workload_target_count';
export const ACHIEVEMENT_TARGET_CONFIG_CODE =
  'assessment.achievement_target_count';

export const DEFAULT_WEIGHTS = {
  review: 0.4,
  workload: 0.4,
  achievement: 0.2,
} as const;

export const DEFAULT_WORKLOAD_TARGET_COUNT = 10;
export const DEFAULT_ACHIEVEMENT_TARGET_COUNT = 5;

/** 归一化后实际使用的权重（落进 `Assessment.weights`，R55 / R61） */
export interface ResolvedWeights {
  review: number;
  workload: number;
  achievement: number;
  /** 原始三个值之和不是 1，已按比例缩放 */
  normalized: boolean;
}

/**
 * 把配置里的三个权重变成**可直接用于加权**的一组（R48）。
 *
 * 规则：
 * - 三个值都必须 **≥ 0**，且**和 > 0**；否则抛 **500 / 10000**——
 *   这是配置错误，不是用户输入错误，不能回 400 让调用方去猜；
 * - 和为 1（容差 1e-9）直接用；否则**按比例归一化**，并置 `normalized = true`。
 *
 * 为什么不直接报错：一次误配会让整个考核功能不可用（学院提交不了初评）。
 * 为什么不静默归一化：`normalized` 会随 `weights` 一起落库并回显，
 * 偏差看得见——这是「不可用」与「不可见」之间的折中。
 */
export function resolveWeights(raw: {
  review: number;
  workload: number;
  achievement: number;
}): ResolvedWeights {
  const values = [raw.review, raw.workload, raw.achievement];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new BusinessException(
      ErrorCode.INTERNAL_ERROR,
      '考核权重配置非法：三个值都必须是非负数',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  if (sum <= 0) {
    throw new BusinessException(
      ErrorCode.INTERNAL_ERROR,
      '考核权重配置非法：三个值之和必须大于 0',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
  if (Math.abs(sum - 1) < 1e-9) {
    return {
      review: raw.review,
      workload: raw.workload,
      achievement: raw.achievement,
      normalized: false,
    };
  }
  return {
    review: round4(raw.review / sum),
    workload: round4(raw.workload / sum),
    achievement: round4(raw.achievement / sum),
    normalized: true,
  };
}

/** 目标值兜底：≤ 0 时按 1 处理，避免除零（R49） */
export function safeTargetCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
