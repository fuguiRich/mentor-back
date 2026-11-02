import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length } from 'class-validator';
import { toNumberIfNumericString } from '../../appointment/dto/create-appointment.dto';
import { ASSESSMENT_GRADES } from '../assessment.constants';

export const FINAL_REVIEW_DECISIONS = ['approve', 'return'] as const;

/**
 * `POST /assessments/:id/final-review` 的请求体（R54 / R56）。
 *
 * 两个决定的要求**互斥**：
 * - `approve`：`grade` **必填**，`comment` 必填 → `1 → 2 APPROVED`；
 * - `return`：`grade` **必须缺省**（多传 → 400 / 10001），`comment` 必填 → `1 → 3 RETURNED`。
 *
 * 「退回还带等级」是自相矛盾的输入：等级是「通过之后定什么级」，
 * 退回了就没有级。放行会让 `finalGrade` 在 `status = 3` 上留一个值，
 * 而那个值没有任何业务含义。
 *
 * DTO 层只能表达 `grade` 的取值合法（`@IsOptional` + `@IsIn`），
 * 「哪个决定要它」由 Service 判——那里的错误信息能点名 `decision`。
 */
export class FinalReviewDto {
  @ApiProperty({
    description: '决定：`approve` 通过 / `return` 退回',
    enum: FINAL_REVIEW_DECISIONS,
    example: 'approve',
  })
  @IsIn(FINAL_REVIEW_DECISIONS, {
    message: 'decision 只能是 approve 或 return',
  })
  decision!: 'approve' | 'return';

  @ApiPropertyOptional({
    description:
      '终评等级：1 优秀 / 2 合格 / 3 不合格；`approve` 时必填，`return` 时必须缺省',
    enum: ASSESSMENT_GRADES,
    example: 1,
  })
  @IsOptional()
  @Transform(toNumberIfNumericString)
  @IsInt({ message: 'grade 必须是 1 / 2 / 3' })
  @IsIn(ASSESSMENT_GRADES, { message: 'grade 必须是 1 / 2 / 3' })
  grade?: number;

  @ApiProperty({
    description: '终评意见，1-1000 字（两个决定都必填）',
    example: '结合全校指导成果，本年度表现优秀。',
  })
  @IsString({ message: 'comment 必须是字符串' })
  @Length(1, 1000, { message: 'comment 长度必须是 1-1000 个字符' })
  comment!: string;
}
