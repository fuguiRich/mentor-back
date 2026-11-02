import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * `POST /appointments/:id/reject` 的请求体（Task 24）。
 *
 * 拒绝**必须填原因**（1-500 字）：`reason` 是唯一必填字段，缺省 / 空串 / `null`
 * 一律 **400 / 10001**，`data.fields` 点名 `reason`（ERR-06）。
 */
export class RejectAppointmentDto {
  @ApiProperty({
    description: '拒绝原因（必填，1-500 字）',
    maxLength: 500,
    example: '该时段已排满，请另约时间',
  })
  @IsString({ message: 'reason 必须是字符串' })
  @IsNotEmpty({ message: 'reason 不能为空' })
  @MaxLength(500, { message: 'reason 长度不能超过 500 个字符' })
  reason!: string;
}
