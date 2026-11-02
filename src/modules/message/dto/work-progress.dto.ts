import { ApiProperty } from '@nestjs/swagger';

/** 一位导师的工作进度 */
export class WorkProgressMentorDto {
  @ApiProperty({
    description: '导师档案 ID（BIGINT 对外字符串）',
    example: '1',
  })
  mentorProfileId!: string;

  @ApiProperty({ description: '导师姓名', example: '张明远' })
  mentorName!: string;

  @ApiProperty({
    description: '所属学院 ID（BIGINT 对外字符串）',
    type: String,
    nullable: true,
    example: '2',
  })
  deptId!: string | null;

  @ApiProperty({ description: '待确认预约数', example: 2 })
  pendingAppointments!: number;

  @ApiProperty({ description: '逾期未填指导记录数', example: 1 })
  missingRecords!: number;

  @ApiProperty({ description: '当前学期待处理考核数', example: 1 })
  pendingAssessments!: number;
}

/** `GET /work-progress` 的响应（§4.5） */
export class WorkProgressResponseDto {
  @ApiProperty({ description: '范围内生效导师数', example: 3 })
  totalMentors!: number;

  @ApiProperty({ description: '待确认预约总数', example: 5 })
  pendingAppointments!: number;

  @ApiProperty({ description: '逾期未填记录总数', example: 2 })
  missingRecords!: number;

  @ApiProperty({ description: '当前学期待处理考核总数', example: 1 })
  pendingAssessments!: number;

  @ApiProperty({ type: [WorkProgressMentorDto] })
  mentors!: WorkProgressMentorDto[];
}
