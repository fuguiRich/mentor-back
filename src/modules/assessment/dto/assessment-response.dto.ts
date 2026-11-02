import { ApiProperty } from '@nestjs/swagger';

/** 本次计算实际使用的权重（`normalized = true` 表示配置的和不是 1，已按比例缩放） */
export class AssessmentWeightsDto {
  @ApiProperty({ description: '学生评价权重', example: 0.4 })
  review!: number;

  @ApiProperty({ description: '指导工作量权重', example: 0.4 })
  workload!: number;

  @ApiProperty({ description: '双创成果权重', example: 0.2 })
  achievement!: number;

  @ApiProperty({
    description: '配置的三个权重之和不是 1，已按比例归一化',
    example: false,
  })
  normalized!: boolean;
}

/**
 * 考核指标。
 *
 * `status = 0` 时是**实时试算**（按当前配置现算）；`status ≥ 1` 时是**冻结值**
 * （提交初评那一刻整组落库，R55）。同一个形状、两种来源——前端不用分两套解析，
 * 但要清楚「提交后数字不会再变」。
 *
 * `reviewAvg` / `compositeScore` 是 DECIMAL，对外**字符串**（RES-08 同源口径）。
 * `reviewAvg` 在**没有评价时是 `null`，不是 `0`**。
 */
export class AssessmentMetricsDto {
  @ApiProperty({
    description: '学生评价均分（0-5，字符串）；无评价时为 null',
    type: String,
    nullable: true,
    example: '4.33',
  })
  reviewAvg!: string | null;

  @ApiProperty({ description: '评价条数', example: 3 })
  reviewCount!: number;

  @ApiProperty({
    description: '指导次数（只算已完成 `6` 的预约）',
    example: 12,
  })
  guidanceCount!: number;

  @ApiProperty({ description: '指导总时长（分钟）', example: 720 })
  guidanceMinutes!: number;

  @ApiProperty({ description: '去重学生数', example: 5 })
  studentCount!: number;

  @ApiProperty({ description: '双创成果数', example: 2 })
  achievementCount!: number;

  @ApiProperty({ description: '加权总分（百分制，字符串）', example: '72.40' })
  compositeScore!: string;
}

/**
 * 一条考核的响应形状（RES-03 / RES-04）。
 *
 * 字段按「初评 → 终评」两跳分组：`college*` 是学院填的，`final*` 是双创学院填的。
 * `finalGrade` 与 `collegeGrade` **互不覆盖**——终评等级可以不同于初评（R54）。
 */
export class AssessmentResponseDto {
  @ApiProperty({ description: '考核行 ID（BIGINT 对外字符串）', example: '1' })
  id!: string;

  @ApiProperty({
    description: '导师档案 ID（BIGINT 对外字符串）',
    example: '1',
  })
  mentorProfileId!: string;

  @ApiProperty({
    description: '考核周期（`YYYY-S`，S=1 上半年 / 2 下半年）',
    example: '2026-1',
  })
  period!: string;

  @ApiProperty({
    description: '状态：0 待初评 / 1 待终评 / 2 已生效 / 3 已退回',
    example: 0,
  })
  status!: number;

  @ApiProperty({
    description: '本次计算使用的权重',
    type: AssessmentWeightsDto,
  })
  weights!: AssessmentWeightsDto;

  @ApiProperty({
    description: '指标（`status = 0` 实时试算，`≥ 1` 冻结值）',
    type: AssessmentMetricsDto,
  })
  metrics!: AssessmentMetricsDto;

  @ApiProperty({
    description: '初评等级：1 优秀 / 2 合格 / 3 不合格；未提交时为 null',
    type: Number,
    nullable: true,
    example: null,
  })
  collegeGrade!: number | null;

  @ApiProperty({
    description: '初评意见；未提交时为 null',
    type: String,
    nullable: true,
    example: null,
  })
  collegeComment!: string | null;

  @ApiProperty({
    description: '初评提交时间（ISO 8601）；未提交时为 null',
    type: String,
    nullable: true,
    example: null,
  })
  collegeSubmittedAt!: string | null;

  @ApiProperty({
    description: '终评等级：1 优秀 / 2 合格 / 3 不合格；未终评时为 null',
    type: Number,
    nullable: true,
    example: null,
  })
  finalGrade!: number | null;

  @ApiProperty({
    description: '终评意见；未终评时为 null',
    type: String,
    nullable: true,
    example: null,
  })
  finalComment!: string | null;

  @ApiProperty({
    description: '终评时间（ISO 8601）；未终评时为 null',
    type: String,
    nullable: true,
    example: null,
  })
  finalReviewedAt!: string | null;

  @ApiProperty({
    description: '创建时间（ISO 8601）',
    example: '2026-11-01T02:00:00.000Z',
  })
  createdAt!: string;
}

/** `GET /assessments` 的响应（RES-06） */
export class AssessmentListResponseDto {
  @ApiProperty({ description: '当前页考核', type: [AssessmentResponseDto] })
  list!: AssessmentResponseDto[];

  @ApiProperty({ description: '总条数', example: 12 })
  total!: number;

  @ApiProperty({ description: '当前页码', example: 1 })
  page!: number;

  @ApiProperty({ description: '每页条数', example: 20 })
  pageSize!: number;
}
