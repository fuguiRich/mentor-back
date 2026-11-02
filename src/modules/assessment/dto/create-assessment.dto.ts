import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

/**
 * `POST /assessments` 的请求体：学院为本院一位导师开一个考核周期。
 *
 * `period` 只接受学期 `YYYY-S`（S=1/2，P5-R5）。同一导师同一周期只能有一条
 * 考核（DB 唯一键），重复 → 409 / 35003。
 */
export class CreateAssessmentDto {
  @ApiProperty({
    description: '导师档案 ID（MentorProfile.id，BIGINT 对外字符串）',
    example: '1',
  })
  @IsBigIntId({ message: 'mentorId 必须是合法的数字 ID' })
  mentorId!: string;

  @ApiProperty({
    description: '考核周期：`YYYY-S`，S=1 上半年 / 2 下半年（如 2026-1）',
    example: '2026-1',
  })
  @IsString({ message: 'period 必须是学期字符串' })
  @Matches(/^\d{4}-[12]$/, {
    message: 'period 必须是 YYYY-S（S=1/2），如 2026-1',
  })
  period!: string;
}
