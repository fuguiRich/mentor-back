import { ApiProperty } from '@nestjs/swagger';

export class MentorRecordResponseDto {
  @ApiProperty({ description: '预约 ID', example: '1' })
  appointmentId!: string;

  @ApiProperty({ description: '学生姓名', example: '陈一鸣' })
  studentName!: string;

  @ApiProperty({ description: '学生学号', example: 'S001' })
  studentLogin!: string;

  @ApiProperty({
    description:
      '预约类型：1 双创竞赛 / 2 科研项目 / 3 创业实践 / 4 论文专利 / 5 其他',
    example: 1,
  })
  type!: number;

  @ApiProperty({
    description:
      '预约状态：0 待确认 / 1 已确认 / 2 进行中 / 3 记录已提交 / 4 学生已确认 / 5 有异议 / 6 已完成 / 7 已拒绝 / 8 已取消 / 9 已过期',
    example: 6,
  })
  status!: number;

  @ApiProperty({ description: '实际指导时间（UTC ISO 8601）' })
  actualTime!: string;

  @ApiProperty({ description: '指导方式：1 线上 / 2 线下', example: 2 })
  mode!: number;

  @ApiProperty({ description: '核心指导内容' })
  coreContent!: string;

  @ApiProperty({ description: '后续指导建议' })
  followUp!: string;

  @ApiProperty({ description: '指导时长（分钟）；0 表示未填', example: 60 })
  durationMinutes!: number;
}

export class MentorRecordListResponseDto {
  @ApiProperty({ type: [MentorRecordResponseDto] })
  list!: MentorRecordResponseDto[];

  @ApiProperty({ description: '总条数', example: 12 })
  total!: number;

  @ApiProperty({ description: '页码', example: 1 })
  page!: number;

  @ApiProperty({ description: '每页条数', example: 20 })
  pageSize!: number;
}
