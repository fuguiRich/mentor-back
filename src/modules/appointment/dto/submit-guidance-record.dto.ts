import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsISO8601,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  Validate,
} from 'class-validator';
import { IsDateBoundary } from '../../../common/decorators/is-date-boundary.validator';
import {
  APPOINTMENT_MODES,
  APPOINTMENT_MODE,
  toNumberIfNumericString,
} from './create-appointment.dto';

/**
 * `POST /appointments/:id/record` 的请求体（Task 26，R26 / 需求 §3.4 逐条落）。
 *
 * §3.4 原文是「填写学生信息、实际指导时间、指导方式、核心指导内容、后续指导
 * 建议」——**「学生信息」不在请求体里**：它由 `appointment.studentPersonId`
 * 联查返回（R27），客户端传什么都不该改得了它。
 *
 * - `actualTime`：**ISO 8601 字符串**（数字时间戳不收），且**不得晚于当前时间**
 *   （R35，否则 400 / 10001 点名 `actualTime`）；
 * - `mode`：1 线上 / 2 线下，其余 400 点名 `mode`；
 * - `coreContent`：1-5000 字；
 * - `followUp`：1-2000 字。
 */
export class SubmitGuidanceRecordDto {
  @ApiProperty({
    description:
      '实际指导时间，**ISO 8601 字符串**（数字时间戳不收）；不得晚于当前时间（R35）',
    example: '2026-10-30T02:00:00.000Z',
  })
  @IsString({ message: 'actualTime 必须是 ISO 8601 字符串' })
  @IsISO8601(
    { strict: true },
    { message: 'actualTime 必须是合法的 ISO 8601 时间' },
  )
  @Validate(IsDateBoundary, ['past'])
  actualTime!: string;

  @ApiProperty({
    description: '指导方式：1 线上 / 2 线下',
    enum: APPOINTMENT_MODES,
    example: APPOINTMENT_MODE.ONLINE,
  })
  @Transform(toNumberIfNumericString)
  @IsInt({ message: 'mode 只能是 1 或 2' })
  @IsIn(APPOINTMENT_MODES, { message: 'mode 只能是 1 或 2' })
  mode!: number;

  @ApiProperty({
    description: '核心指导内容，1-5000 字',
    example: '围绕挑战杯选题，梳理了三条可行技术路线并确定主攻方向。',
  })
  @IsString({ message: 'coreContent 必须是字符串' })
  @Length(1, 5000, { message: 'coreContent 长度必须是 1-5000 个字符' })
  coreContent!: string;

  @ApiProperty({
    description: '后续指导建议，1-2000 字',
    example: '下次带原型演示，重点讲清数据来源与评测口径。',
  })
  @IsString({ message: 'followUp 必须是字符串' })
  @Length(1, 2000, { message: 'followUp 长度必须是 1-2000 个字符' })
  followUp!: string;

  /**
   * 指导时长（分钟），P3 Task 35 / R58 新增。§5.2 的「指导工作量（次数、**时长**、
   * 学生数）」要有它才算得出来。
   *
   * **可选**：P2 已上线的提交方（前端 / 手工测试脚本）不会传，强制必填会直接打断
   * 它们。不传落 `0`，语义是「未填」，不是「零分钟」。
   * 传了就必须是 1-600 的整数——`0` 是 400：「传 0」与「不传」是两种意思，
   * 前者是填错了，不该静默当成未填。
   */
  @ApiPropertyOptional({
    description: '指导时长（分钟），1-600；不传落 0（表示未填）',
    example: 60,
    minimum: 1,
    maximum: 600,
  })
  @IsOptional()
  @Transform(toNumberIfNumericString)
  @IsInt({ message: 'durationMinutes 必须是整数分钟' })
  @Min(1, { message: 'durationMinutes 不能小于 1' })
  @Max(600, { message: 'durationMinutes 不能大于 600' })
  durationMinutes?: number;
}
