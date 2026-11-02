import { ApiProperty } from '@nestjs/swagger';

/** 按预约类型拆分的指导量 */
export class GuidanceTypeCountDto {
  @ApiProperty({
    description:
      '预约类型：1 双创竞赛指导 / 2 科研项目指导 / 3 创业实践指导 / ' +
      '4 论文·专利指导 / 5 其他双创指导',
    example: 1,
  })
  type!: number;

  @ApiProperty({ description: '该类型的指导次数', example: 8 })
  count!: number;

  @ApiProperty({ description: '该类型的指导总时长（分钟）', example: 480 })
  minutes!: number;
}

/** 单个导师的指导量（`byMentor` 的明细页） */
export class MentorGuidanceDto {
  @ApiProperty({
    description: '导师档案 ID（BIGINT 对外字符串）',
    example: '1',
  })
  mentorProfileId!: string;

  @ApiProperty({ description: '导师姓名', example: '导师甲' })
  mentorName!: string;

  @ApiProperty({ description: '指导次数', example: 12 })
  guidanceCount!: number;

  @ApiProperty({ description: '指导总时长（分钟）', example: 720 })
  guidanceMinutes!: number;

  @ApiProperty({ description: '去重学生数', example: 5 })
  studentCount!: number;

  @ApiProperty({ description: '同期成果数', example: 2 })
  achievementCount!: number;
}

/**
 * `GET /stats/guidance` 的响应（§4.6 / §3.7）。
 *
 * **顶层 5 个合计与 `byType` 是全量口径**，不受 `byMentor` 的分页影响；
 * `byMentor` 只是明细页。混用会让前端把「本页合计」当成总数。
 *
 * 口径与 P3 的考核指标**完全一致**：`guidanceCount` 只算
 * `appointment.status = 6 COMPLETED` 且 `GuidanceRecord.actualTime ∈ 区间` 的记录。
 */
export class GuidanceStatsResponseDto {
  @ApiProperty({ description: '指导次数（全量）', example: 40 })
  guidanceCount!: number;

  @ApiProperty({ description: '指导总时长（分钟，全量）', example: 2400 })
  guidanceMinutes!: number;

  @ApiProperty({ description: '去重学生数（全量）', example: 18 })
  studentCount!: number;

  @ApiProperty({ description: '同期成果数（全量）', example: 7 })
  achievementCount!: number;

  @ApiProperty({
    description: '按预约类型拆分（1-5 五条齐全）',
    type: [GuidanceTypeCountDto],
  })
  byType!: GuidanceTypeCountDto[];

  @ApiProperty({
    description: '按导师下钻的明细（分页）',
    type: [MentorGuidanceDto],
  })
  byMentor!: MentorGuidanceDto[];

  @ApiProperty({
    description: '有指导记录的导师数（`byMentor` 的总条数）',
    example: 12,
  })
  byMentorTotal!: number;

  @ApiProperty({ description: '当前页码', example: 1 })
  page!: number;

  @ApiProperty({ description: '每页条数', example: 20 })
  pageSize!: number;
}
