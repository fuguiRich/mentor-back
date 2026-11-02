import { ApiProperty } from '@nestjs/swagger';
import {
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  Validate,
} from 'class-validator';
import { IsDateBoundary } from '../../../common/decorators/is-date-boundary.validator';

/**
 * `POST /appointments/:id/reschedule` 的请求体（Task 24，R13 / R30 / R33）。
 *
 * - `proposedTime`：**ISO 8601 字符串**（数字时间戳不收），且**必须晚于当前时间**
 *   （否则 400 / 10001，点名 `proposedTime`）。「必须是未来」这一条复用共用的
 *   `IsDateBoundary`——它按被校验字段名生成文案，与 `requestedTime` 共用不会串名
 *   （ERR-06；`data.fields` 的字段定位来自 `error.property`）。
 * - **不校验是否落在导师开放时段内**（R33）——导师临时安排不该被自己的周表卡住；
 * - `comment` 可选（0-500 字）：省略 / `null` 都表示「本次不填意见」（语义 ①，DTO-14）。
 */
export class RescheduleAppointmentDto {
  @ApiProperty({
    description:
      '导师建议的新时间，**ISO 8601 字符串**（数字时间戳不收）；必须晚于当前时间（R30）。' +
      '**不校验是否落在导师开放时段内**（R33）。',
    example: '2026-11-03T02:00:00.000Z',
  })
  @IsString({ message: 'proposedTime 必须是 ISO 8601 字符串' })
  @IsISO8601(
    { strict: true },
    { message: 'proposedTime 必须是合法的 ISO 8601 时间' },
  )
  @Validate(IsDateBoundary, ['future'])
  proposedTime!: string;

  /** null 与不传同义：都表示「本次不填意见」（语义 ①，DTO-14） */
  @ApiProperty({
    description:
      '导师处理意见（可选，0-500 字）；省略或 null 表示不填，落库为 null',
    // `string | null` 的 design:type 是 Object，不写 type 会退化成 object（DOC-06）
    type: String,
    required: false,
    maxLength: 500,
    example: '原时间有冲突，改到周二上午',
  })
  @IsOptional()
  @IsString({ message: 'comment 必须是字符串' })
  @MaxLength(500, { message: 'comment 长度不能超过 500 个字符' })
  comment?: string | null;
}
