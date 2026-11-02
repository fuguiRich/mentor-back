import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsString, Length } from 'class-validator';
import { toNumberIfNumericString } from '../../appointment/dto/create-appointment.dto';
import { ASSESSMENT_GRADES } from '../assessment.constants';

/**
 * `POST /assessments/:id/college-review` 的请求体（R53：**没有草稿态**）。
 *
 * 学院在 `GET /assessments/:id` 里看到实时指标，想清楚再提交；提交即
 * `0 DRAFT | 3 RETURNED → 1 COLLEGE_SUBMITTED`，同一事务里把 6 个指标 +
 * `compositeScore` + `weights` 整组冻结（R55）。
 *
 * `grade` 是**人工判断**，不由 `compositeScore` 推导（R50）：§5.2 原文是
 * 「填写初评意见、初评等级」——是人填的。自动推导会把「不合格」变成机器判的，
 * 学院无法解释。
 */
export class CollegeReviewDto {
  @ApiProperty({
    description: '初评等级：1 优秀 / 2 合格 / 3 不合格',
    enum: ASSESSMENT_GRADES,
    example: 2,
  })
  @Transform(toNumberIfNumericString)
  @IsInt({ message: 'grade 必须是 1 / 2 / 3' })
  @IsIn(ASSESSMENT_GRADES, { message: 'grade 必须是 1 / 2 / 3' })
  grade!: number;

  @ApiProperty({
    description: '初评意见，1-1000 字',
    example: '本年度指导 12 次，学生评价良好，成果 2 项，符合合格标准。',
  })
  @IsString({ message: 'comment 必须是字符串' })
  @Length(1, 1000, { message: 'comment 长度必须是 1-1000 个字符' })
  comment!: string;
}
