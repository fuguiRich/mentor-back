import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * `POST /appointments/:id/dispute` 的请求体（Task 27 / 需求 §2.4）。
 *
 * 学生对指导记录提异议**必须填原因**（1-500 字）：`reason` 是唯一必填字段，
 * 缺省 / 空串 / `null` 一律 **400 / 10001**，`data.fields` 点名 `reason`（ERR-06）。
 * 落库写进 `Appointment.disputeReason`——**不复用** `rejectReason`（导师拒绝预约）
 * 或 `handleComment`（导师处理意见），三者语义不同。
 */
export class DisputeAppointmentDto {
  @ApiProperty({
    description: '异议原因（必填，1-500 字）',
    maxLength: 500,
    example: '记录中的实际指导时间与当天安排不符，请复核。',
  })
  @IsString({ message: 'reason 必须是字符串' })
  @IsNotEmpty({ message: 'reason 不能为空' })
  @MaxLength(500, { message: 'reason 长度不能超过 500 个字符' })
  reason!: string;
}
