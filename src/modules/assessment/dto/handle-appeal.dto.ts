import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Length } from 'class-validator';

export const APPEAL_DECISIONS = ['accept', 'reject'] as const;

/**
 * `POST /assessments/:id/appeals/:appealId/handle` 的请求体（R56）。
 *
 * `accept` → 申诉 `1 ACCEPTED`；`reject` → `2 REJECTED`。**两个决定都不改
 * `Assessment`**——受理只表示双创学院已收到并会复核，不是「重新定级」。
 * `reply` 两个决定都必填：驳回必须说明理由，否则导师不知道下一步该做什么。
 */
export class HandleAppealDto {
  @ApiProperty({
    description: '处理决定：`accept` 受理 / `reject` 驳回',
    enum: APPEAL_DECISIONS,
    example: 'accept',
  })
  @IsIn(APPEAL_DECISIONS, {
    message: 'decision 只能是 accept 或 reject',
  })
  decision!: 'accept' | 'reject';

  @ApiProperty({
    description: '处理意见，1-1000 字（两个决定都必填）',
    example: '已收到，将在本月底前完成复核并反馈。',
  })
  @IsString({ message: 'reply 必须是字符串' })
  @Length(1, 1000, { message: 'reply 长度必须是 1-1000 个字符' })
  reply!: string;
}
