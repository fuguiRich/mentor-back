import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * `POST /appointments/:id/confirm` 的请求体（Task 24，§3.3「操作时填写相关意见」）。
 *
 * 确认时的意见**可选**（0-500 字）：省略 / `null` 都表示「本次不填意见」，
 * 落库时 `handleComment = comment ?? null`（DTO-14 语义 ①）。
 * 空串 `""` 是合法的「填了但为空」，落库仍是 `""`——它不等于「没填」。
 */
export class ConfirmAppointmentDto {
  /** null 与不传同义：都表示「本次不填意见」（语义 ①，DTO-14） */
  @ApiProperty({
    description:
      '导师处理意见（可选，0-500 字）；省略或 null 表示不填，落库为 null',
    // `string | null` 的 design:type 是 Object，不写 type 会退化成 object（DOC-06）
    type: String,
    required: false,
    maxLength: 500,
    example: '时间没问题，请准时参加',
  })
  @IsOptional()
  @IsString({ message: 'comment 必须是字符串' })
  @MaxLength(500, { message: 'comment 长度不能超过 500 个字符' })
  comment?: string | null;
}
