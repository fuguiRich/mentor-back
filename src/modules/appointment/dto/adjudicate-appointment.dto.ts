import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Length } from 'class-validator';

/**
 * 管理员对 `5 DISPUTED` 的复核决定（Task 28 / 需求 §4.3）。
 *
 * - `uphold`：支持学生，异议成立 → `6 COMPLETED`；
 * - `return`：不支持学生，退回导师重填 → `3 RECORD_SUBMITTED`。
 */
export const ADJUDICATE_DECISION = {
  UPHOLD: 'uphold',
  RETURN: 'return',
} as const;

export type AdjudicateDecision =
  (typeof ADJUDICATE_DECISION)[keyof typeof ADJUDICATE_DECISION];

/** 合法的 decision 取值，DTO 的 `@IsIn` 与 OpenAPI 的 enum 共用 */
export const ADJUDICATE_DECISIONS: readonly string[] = [
  ADJUDICATE_DECISION.UPHOLD,
  ADJUDICATE_DECISION.RETURN,
];

/**
 * `POST /appointments/:id/adjudicate` 的请求体（Task 28 / 需求 §4.3）。
 *
 * 两个字段**都必填**：
 * - `decision` 只能是 `uphold` / `return`，其它值 → **400 / 10001**，点名 `decision`；
 * - `comment`（审核意见）1-500 字，缺省 / 空串 / 超长 → **400 / 10001**，点名
 *   `comment`（ERR-06）。落库写进 `Appointment.adjudicateComment`——**不复用**
 *   `handleComment`（导师处理意见）/ `rejectReason`（导师拒绝预约）/
 *   `disputeReason`（学生异议原因），四者语义各不相同。
 */
export class AdjudicateAppointmentDto {
  @ApiProperty({
    description:
      '复核决定：uphold 支持学生（→ 6 COMPLETED）/ return 退回重填（→ 3）',
    enum: ADJUDICATE_DECISIONS,
    example: ADJUDICATE_DECISION.UPHOLD,
  })
  @IsIn(ADJUDICATE_DECISIONS, {
    message: 'decision 只能是 uphold 或 return',
  })
  decision!: AdjudicateDecision;

  @ApiProperty({
    description: '审核意见（必填，1-500 字）',
    minLength: 1,
    maxLength: 500,
    example: '经核对，记录中的实际指导时间与学生当日课表冲突，异议成立。',
  })
  @IsString({ message: 'comment 必须是字符串' })
  @Length(1, 500, { message: 'comment 长度必须是 1-500 个字符' })
  comment!: string;
}
