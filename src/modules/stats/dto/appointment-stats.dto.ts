import { ApiProperty } from '@nestjs/swagger';

/** 单个状态的预约数（10 个状态必须全列，缺项补 0） */
export class AppointmentStatusCountDto {
  @ApiProperty({
    description:
      '状态：0 PENDING / 1 CONFIRMED / 2 IN_PROGRESS / 3 RECORD_SUBMITTED / ' +
      '4 STUDENT_CONFIRMED / 5 DISPUTED / 6 COMPLETED / 7 REJECTED / ' +
      '8 CANCELLED / 9 EXPIRED',
    example: 0,
  })
  status!: number;

  @ApiProperty({ description: '该状态的预约数', example: 3 })
  count!: number;
}

/** 一对「多次预约失败」的师生（§5.3 线下协调提醒的名单） */
export class FailedPairDto {
  @ApiProperty({
    description: '学生 ID（SyncPerson.id，BIGINT 对外字符串）',
    example: '2',
  })
  studentPersonId!: string;

  @ApiProperty({ description: '学生姓名', example: '陈一鸣' })
  studentName!: string;

  @ApiProperty({
    description: '导师档案 ID（BIGINT 对外字符串）',
    example: '1',
  })
  mentorProfileId!: string;

  @ApiProperty({ description: '导师姓名', example: '导师甲' })
  mentorName!: string;

  @ApiProperty({
    description: '该对师生 `7 / 8 / 9` 的预约条数',
    example: 3,
  })
  failedCount!: number;
}

/**
 * `GET /stats/appointments` 的响应（§4.2 / §5.3）。
 *
 * 两个比率（R63）：
 * - `acceptanceRate`（预约成功率）= `count(status ∈ {1..6}) / count(all)`——
 *   衡量「导师接不接」；
 * - `completionRate`（指导完成率）= `count(6) / count(status ∈ {6,7,8,9})`——
 *   衡量「接了的做没做完」。
 *
 * 分母为 0 时**返回 `null`，不是 0**：把「没有任何预约」显示成「成功率 0%」
 * 是一句假话。
 */
export class AppointmentStatsResponseDto {
  @ApiProperty({ description: '预约总数', example: 20 })
  total!: number;

  @ApiProperty({
    description: '状态分布（10 个状态齐全）',
    type: [AppointmentStatusCountDto],
  })
  byStatus!: AppointmentStatusCountDto[];

  @ApiProperty({
    description: '预约成功率；无预约时为 null',
    type: Number,
    nullable: true,
    example: 0.75,
  })
  acceptanceRate!: number | null;

  @ApiProperty({
    description: '指导完成率；无终态预约时为 null',
    type: Number,
    nullable: true,
    example: 0.5,
  })
  completionRate!: number | null;

  @ApiProperty({
    description: '多次预约失败的师生（按失败数倒序，最多 50 条）',
    type: [FailedPairDto],
  })
  failedPairs!: FailedPairDto[];
}
