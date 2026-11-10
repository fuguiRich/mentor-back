import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { toNumberIfNumericString } from '../../appointment/dto/create-appointment.dto';
import {
  ASSESSMENT_GRADES,
  ASSESSMENT_STATUS_VALUES,
} from '../assessment.constants';

const STATUSES = ASSESSMENT_STATUS_VALUES;

/** `GET /assessments` 的查询参数（Task 41） */
export class QueryAssessmentDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '考核周期：`YYYY-S`（S=1/2）或历史四位年份',
    example: '2026-1',
  })
  @IsOptional()
  @Matches(/^\d{4}(-[12])?$/, {
    message: 'period 必须是 YYYY-S（S=1/2）或四位年份',
  })
  period?: string;

  @ApiPropertyOptional({
    description:
      '状态：0 待初评 / 1 待终评 / 2 已生效 / 3 已退回 / 4 申诉中 / ' +
      '5 申诉已受理 / 6 申诉已驳回',
    enum: STATUSES,
  })
  @IsOptional()
  @Transform(toNumberIfNumericString)
  @IsInt()
  @IsIn(STATUSES)
  status?: number;

  @ApiPropertyOptional({
    description: '等级（按 `finalGrade`，未终评的用 `collegeGrade`）',
    enum: ASSESSMENT_GRADES,
  })
  @IsOptional()
  @Transform(toNumberIfNumericString)
  @IsInt()
  @IsIn(ASSESSMENT_GRADES)
  grade?: number;
}
