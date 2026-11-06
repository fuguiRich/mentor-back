import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsISO8601, IsInt, IsOptional, Max, Min } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

/**
 * `/me/records` 与 `/me/reviews` 的查询参数。
 *
 * `from` / `to` 是 ISO 8601 时间；`/me/records` 按实际指导时间过滤，
 * `/me/reviews` 按评价时间过滤。纯日期按 UTC 零点解释（与统计模块一致）。
 */
export class QueryMyRecordDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '起始时间（含，ISO 8601）',
    example: '2026-01-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'from 必须是合法的 ISO 8601 时间' })
  from?: string;

  @ApiPropertyOptional({
    description: '结束时间（含，ISO 8601）',
    example: '2026-12-31T23:59:59.999Z',
  })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'to 必须是合法的 ISO 8601 时间' })
  to?: string;

  @ApiPropertyOptional({
    description:
      '预约类型：1 双创竞赛 / 2 科研项目 / 3 创业实践 / 4 论文专利 / 5 其他',
    example: 1,
    enum: [1, 2, 3, 4, 5],
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'type 必须是 1-5 的整数' })
  @Min(1, { message: 'type 必须是 1-5 的整数' })
  @Max(5, { message: 'type 必须是 1-5 的整数' })
  type?: number;
}

/** `/me/records` 的一行：预约 + 指导记录 + 我的评价（没写的字段为 null） */
export class MeRecordResponseDto {
  @ApiProperty({ description: '预约 ID', example: '1' })
  appointmentId!: string;

  @ApiProperty({ description: '导师档案 ID', example: '1' })
  mentorProfileId!: string;

  @ApiProperty({ description: '导师姓名', example: '张明远' })
  mentorName!: string;

  @ApiProperty({
    description: '预约类型：1-5',
    example: 1,
  })
  type!: number;

  @ApiProperty({ description: '预约类型名称', example: '双创竞赛指导' })
  typeLabel!: string;

  @ApiProperty({ description: '指导主题', example: '挑战杯项目选题与打磨' })
  topic!: string;

  @ApiProperty({
    type: String,
    description: '实际指导时间（ISO 8601）；记录未填时为 null',
    nullable: true,
    example: '2026-11-01T02:00:00.000Z',
  })
  actualTime!: string | null;

  @ApiProperty({
    type: Number,
    description: '指导时长（分钟）；记录未填时为 null',
    nullable: true,
    example: 60,
  })
  durationMinutes!: number | null;

  @ApiProperty({
    type: Number,
    description: '指导态度 1-5；未评价为 null',
    nullable: true,
  })
  attitude!: number | null;

  @ApiProperty({
    type: Number,
    description: '专业能力 1-5；未评价为 null',
    nullable: true,
  })
  expertise!: number | null;

  @ApiProperty({
    type: Number,
    description: '指导效果 1-5；未评价为 null',
    nullable: true,
  })
  effect!: number | null;

  @ApiProperty({
    type: String,
    description: '三维度均分，2 位小数；未评价为 null',
    nullable: true,
    example: '4.33',
  })
  overallScore!: string | null;

  @ApiProperty({
    type: String,
    description: '文字评价；未填为 null',
    nullable: true,
    example: '讲解清晰。',
  })
  comment!: string | null;
}

export class MeRecordListResponseDto {
  @ApiProperty({ type: [MeRecordResponseDto] })
  list!: MeRecordResponseDto[];

  @ApiProperty({ description: '总条数', example: 12 })
  total!: number;

  @ApiProperty({ description: '当前页码', example: 1 })
  page!: number;

  @ApiProperty({ description: '每页条数', example: 20 })
  pageSize!: number;
}

/** `/me/reviews` 的一行：评价 + 预约上下文 */
export class MeReviewResponseDto {
  @ApiProperty({ description: '评价 ID', example: '1' })
  id!: string;

  @ApiProperty({ description: '预约 ID', example: '1' })
  appointmentId!: string;

  @ApiProperty({ description: '导师档案 ID', example: '1' })
  mentorProfileId!: string;

  @ApiProperty({ description: '导师姓名', example: '张明远' })
  mentorName!: string;

  @ApiProperty({ description: '预约类型：1-5', example: 1 })
  type!: number;

  @ApiProperty({ description: '预约类型名称', example: '双创竞赛指导' })
  typeLabel!: string;

  @ApiProperty({ description: '指导主题', example: '挑战杯项目选题与打磨' })
  topic!: string;

  @ApiProperty({ description: '指导态度 1-5', example: 5 })
  attitude!: number;

  @ApiProperty({ description: '专业能力 1-5', example: 4 })
  expertise!: number;

  @ApiProperty({ description: '指导效果 1-5', example: 4 })
  effect!: number;

  @ApiProperty({
    description: '三维度均分，2 位小数',
    example: '4.33',
  })
  overallScore!: string;

  @ApiProperty({
    type: String,
    description: '文字评价；未填为 null',
    nullable: true,
    example: '讲解清晰。',
  })
  comment!: string | null;

  @ApiProperty({
    description: '评价时间（ISO 8601）',
    example: '2026-11-01T03:00:00.000Z',
  })
  createdAt!: string;
}

export class MeReviewListResponseDto {
  @ApiProperty({ type: [MeReviewResponseDto] })
  list!: MeReviewResponseDto[];

  @ApiProperty({ description: '总条数', example: 12 })
  total!: number;

  @ApiProperty({ description: '当前页码', example: 1 })
  page!: number;

  @ApiProperty({ description: '每页条数', example: 20 })
  pageSize!: number;
}
