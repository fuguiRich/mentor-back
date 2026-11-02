import { ApiProperty } from '@nestjs/swagger';

/**
 * 一条评价的响应形状（RES-03 / RES-04：显式映射，不序列化实体）。
 *
 * **匿名**（R44）：不含任何学生身份字段——没有 `studentPersonId`、
 * 没有姓名、没有学号。评价要给导师看、给学院看、给检索页展示；
 * 带上学生身份等于把差评实名化，真实评价率会归零。追溯需求走数据库，不走 API。
 *
 * `overallScore` 是 **DECIMAL → 对外字符串**（`"4.33"`）。不用 number：
 * JS 的 number 在这里没有精度问题，但仓里所有 DECIMAL 一律字符串（RES-08 同源口径），
 * 一处例外就会让前端写出两套解析。
 */
export class ReviewResponseDto {
  @ApiProperty({ description: '评价行 ID（BIGINT 对外字符串）', example: '1' })
  id!: string;

  @ApiProperty({
    description: '被评价的预约 ID（BIGINT 对外字符串）',
    example: '12',
  })
  appointmentId!: string;

  @ApiProperty({
    description: '被评价的导师档案 ID（BIGINT 对外字符串）',
    example: '1',
  })
  mentorProfileId!: string;

  @ApiProperty({ description: '指导态度 1-5', example: 5 })
  attitude!: number;

  @ApiProperty({ description: '专业能力 1-5', example: 4 })
  expertise!: number;

  @ApiProperty({ description: '指导效果 1-5', example: 4 })
  effect!: number;

  @ApiProperty({
    description: '三维度均分，2 位小数（字符串）',
    example: '4.33',
  })
  overallScore!: string;

  @ApiProperty({
    description: '文字评价；未填时为 null',
    type: String,
    nullable: true,
    example: null,
  })
  comment!: string | null;

  @ApiProperty({
    description: '评价时间（ISO 8601）',
    example: '2026-11-01T02:00:00.000Z',
  })
  createdAt!: string;
}

/**
 * 某导师的评价汇总。
 *
 * 四个均值在**没有评价时一律 `null`**，只有 `count` 是 `0`。
 * 把「没人评」显示成「0 分」是报表类接口最常见的谎——0 分与未评价在业务上
 * 是两个相反的事实。
 */
export class ReviewSummaryDto {
  @ApiProperty({ description: '评价条数', example: 12 })
  count!: number;

  @ApiProperty({
    description: '三维度均分的平均；无评价时为 null',
    type: Number,
    nullable: true,
    example: 4.25,
  })
  avg!: number | null;

  @ApiProperty({
    description: '指导态度均分；无评价时为 null',
    type: Number,
    nullable: true,
    example: 4.5,
  })
  attitudeAvg!: number | null;

  @ApiProperty({
    description: '专业能力均分；无评价时为 null',
    type: Number,
    nullable: true,
    example: 4.25,
  })
  expertiseAvg!: number | null;

  @ApiProperty({
    description: '指导效果均分；无评价时为 null',
    type: Number,
    nullable: true,
    example: 4.0,
  })
  effectAvg!: number | null;
}

/** `GET /mentors/:mentorId/reviews` 的响应（RES-06：`list` / `total` / `page` / `pageSize`） */
export class ReviewListResponseDto {
  @ApiProperty({ description: '当前页评价', type: [ReviewResponseDto] })
  list!: ReviewResponseDto[];

  @ApiProperty({ description: '总条数', example: 12 })
  total!: number;

  @ApiProperty({ description: '当前页码', example: 1 })
  page!: number;

  @ApiProperty({ description: '每页条数', example: 20 })
  pageSize!: number;

  @ApiProperty({
    description: '该导师的评价汇总（全量口径，不受分页影响）',
    type: ReviewSummaryDto,
  })
  summary!: ReviewSummaryDto;
}
