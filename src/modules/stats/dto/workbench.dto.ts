import { ApiProperty } from '@nestjs/swagger';

/** 工作台的评价汇总（口径与 `GET /mentors/:id/reviews` 的 `summary` 一致） */
export class WorkbenchReviewSummaryDto {
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

/** 当前学期那条考核的摘要（没有则整体为 null） */
export class WorkbenchAssessmentDto {
  @ApiProperty({ description: '考核 ID（BIGINT 对外字符串）', example: '1' })
  id!: string;

  @ApiProperty({ description: '考核周期', example: '2026' })
  period!: string;

  @ApiProperty({
    description: '状态：0 待初评 / 1 待终评 / 2 已生效 / 3 已退回',
    example: 2,
  })
  status!: number;

  @ApiProperty({
    description: '初评等级；未提交为 null',
    type: Number,
    nullable: true,
    example: 2,
  })
  collegeGrade!: number | null;

  @ApiProperty({
    description: '终评等级；未终评为 null',
    type: Number,
    nullable: true,
    example: 1,
  })
  finalGrade!: number | null;

  @ApiProperty({
    description: '加权总分（字符串）；未提交为 null',
    type: String,
    nullable: true,
    example: '72.40',
  })
  compositeScore!: string | null;
}

/**
 * `GET /mentors/:mentorId/workbench` 的响应（§3.6 导师个人工作台）。
 *
 * **全部是实时值**，不读冻结快照：工作台回答的是「现在怎么样」，
 * 考核详情回答的是「提交时是什么样」。两者混用会让导师以为数据没更新。
 */
export class WorkbenchResponseDto {
  @ApiProperty({ description: '待确认的预约数（`0`）', example: 2 })
  pendingAppointments!: number;

  @ApiProperty({ description: '已确认待指导的预约数（`1`）', example: 1 })
  confirmedAppointments!: number;

  @ApiProperty({
    description: '已填报记录、待学生确认的预约数（`3`）',
    example: 1,
  })
  awaitingStudentConfirm!: number;

  @ApiProperty({ description: '评价汇总', type: WorkbenchReviewSummaryDto })
  reviewSummary!: WorkbenchReviewSummaryDto;

  @ApiProperty({
    description: '当前学期的考核摘要；没有则为 null',
    type: WorkbenchAssessmentDto,
    nullable: true,
  })
  currentAssessment!: WorkbenchAssessmentDto | null;

  @ApiProperty({ description: '该导师名下的归档条目数', example: 3 })
  archivedCount!: number;
}
