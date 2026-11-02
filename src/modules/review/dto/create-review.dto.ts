import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * 学生评价请求体（P3 / 需求 §2.5）。
 *
 * 三个维度各 1-5 分，`comment` 可空（R42）。**没有 `overallScore`**：
 * 总分由服务端按 `round((attitude + expertise + effect) / 3, 2)` 算（R41），
 * 客户端传了会被全局白名单挡下（400 / 10001）——总分若可由客户端指定，
 * 三维度就成了摆设。
 */
export class CreateReviewDto {
  @ApiProperty({
    description: '指导态度评分，1-5',
    example: 5,
    minimum: 1,
    maximum: 5,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  attitude!: number;

  @ApiProperty({
    description: '专业能力评分，1-5',
    example: 4,
    minimum: 1,
    maximum: 5,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  expertise!: number;

  @ApiProperty({
    description: '指导效果评分，1-5',
    example: 4,
    minimum: 1,
    maximum: 5,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  effect!: number;

  /**
   * `@IsOptional()` 同时放行 `undefined` 与 `null`（DTO-14：null 的含义必须显式定下）：
   * 两者都表示「不写文字评价」，落库都是 `NULL`。**不区分**——「没传」与
   * 「明确传 null」在这里没有业务差别，硬分只会多一个状态。
   */
  @ApiPropertyOptional({
    description: '文字评价，≤1000 字；不传或传 null 都落 null',
    example: '讲解清晰，给的三条技术路线很有用。',
    type: String,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string | null;
}
