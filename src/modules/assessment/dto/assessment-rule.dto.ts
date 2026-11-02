import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  Min,
  ValidateNested,
} from 'class-validator';
import { AssessmentWeightsDto } from './assessment-response.dto';

/** `PUT /assessments/rules` 的三个权重（未归一化的原始输入） */
export class AssessmentWeightsInputDto {
  @ApiProperty({ description: '学生评价权重，>= 0', example: 0.4 })
  @IsNumber({}, { message: 'review 必须是数字' })
  @Min(0, { message: 'review 不能小于 0' })
  review!: number;

  @ApiProperty({ description: '指导工作量权重，>= 0', example: 0.4 })
  @IsNumber({}, { message: 'workload 必须是数字' })
  @Min(0, { message: 'workload 不能小于 0' })
  workload!: number;

  @ApiProperty({ description: '双创成果权重，>= 0', example: 0.2 })
  @IsNumber({}, { message: 'achievement 必须是数字' })
  @Min(0, { message: 'achievement 不能小于 0' })
  achievement!: number;
}

/** `PUT /assessments/rules` 的两个目标值（可只改一个） */
export class AssessmentTargetsInputDto {
  @ApiPropertyOptional({
    description: '工作量满分对应的指导次数，>= 1',
    example: 10,
  })
  @IsOptional()
  @IsInt({ message: 'workload 必须是整数' })
  @Min(1, { message: 'workload 不能小于 1' })
  workload?: number;

  @ApiPropertyOptional({
    description: '成果满分对应的成果数，>= 1',
    example: 5,
  })
  @IsOptional()
  @IsInt({ message: 'achievement 必须是整数' })
  @Min(1, { message: 'achievement 不能小于 1' })
  achievement?: number;
}

/**
 * `PUT /assessments/rules`（P5 Task 57 / §6.6）。
 *
 * 三个权重必须有限且 `>= 0`、和 `> 0`；否则 400 / 10001。
 * 和不为 1 时由 `resolveWeights` 归一化，响应里的 `normalized = true`。
 */
export class UpdateAssessmentRuleDto {
  @ApiProperty({ type: AssessmentWeightsInputDto })
  @ValidateNested()
  @Type(() => AssessmentWeightsInputDto)
  weights!: AssessmentWeightsInputDto;

  @ApiPropertyOptional({ type: AssessmentTargetsInputDto })
  @ValidateNested()
  @Type(() => AssessmentTargetsInputDto)
  targets?: AssessmentTargetsInputDto;
}

/** 当前生效的两个目标值 */
export class AssessmentRuleTargetsDto {
  @ApiProperty({ description: '工作量满分对应的指导次数', example: 10 })
  workload!: number;

  @ApiProperty({ description: '成果满分对应的成果数', example: 5 })
  achievement!: number;
}

/** 当前生效的考核评分规则 */
export class AssessmentRuleResponseDto {
  @ApiProperty({ type: AssessmentWeightsDto })
  weights!: AssessmentWeightsDto;

  @ApiProperty({ type: AssessmentRuleTargetsDto })
  targets!: AssessmentRuleTargetsDto;
}
