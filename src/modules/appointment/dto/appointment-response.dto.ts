import { ApiProperty } from '@nestjs/swagger';
import {
  APPOINTMENT_MODES,
  APPOINTMENT_STATUS,
  APPOINTMENT_TYPES,
} from './create-appointment.dto';

/**
 * 一条预约的响应形状（RES-04：显式映射，不序列化实体）。
 *
 * 时间字段一律 ISO 8601 字符串（RES-07）；BIGINT 一律对外字符串（RES-08）。
 * 可空字段（`proposedTime` / `handleComment` / `rejectReason` / `slotId`）
 * 在 `@ApiProperty` 里显式写 `type`——`X | null` 的运行时元数据是 `Object`，
 * 不写 `type` 会退化成 `object`（DOC-06）。
 */
export class AppointmentResponseDto {
  @ApiProperty({ description: '预约行 ID（BIGINT 对外字符串）', example: '1' })
  id!: string;

  @ApiProperty({
    description: '发起预约的学生（SyncPerson.id，BIGINT 对外字符串）',
    example: '2',
  })
  studentPersonId!: string;

  @ApiProperty({
    description: '被预约的导师档案 ID（MentorProfile.id，BIGINT 对外字符串）',
    example: '1',
  })
  mentorProfileId!: string;

  @ApiProperty({
    description:
      '预约类型：1 双创竞赛指导 / 2 科研项目指导 / 3 创业实践指导 / ' +
      '4 论文·专利指导 / 5 其他双创指导',
    enum: APPOINTMENT_TYPES,
    example: 1,
  })
  type!: number;

  @ApiProperty({
    description:
      '状态：0 PENDING | 1 CONFIRMED | 2 IN_PROGRESS | 3 RECORD_SUBMITTED | ' +
      '4 STUDENT_CONFIRMED | 5 DISPUTED | 6 COMPLETED | 7 REJECTED | ' +
      '8 CANCELLED | 9 EXPIRED；新建恒为 0',
    enum: Object.values(APPOINTMENT_STATUS),
    example: APPOINTMENT_STATUS.PENDING,
  })
  status!: number;

  @ApiProperty({
    description:
      '期望指导时间（ISO 8601，UTC 时刻）。展示时转成本地时区——' +
      '它落在导师开放时段内的判断也是按本地墙钟时间做的（R31）',
    example: '2026-11-02T02:00:00.000Z',
  })
  requestedTime!: string;

  @ApiProperty({
    description: '导师改期建议（ISO 8601）；导师尚未改期时为 null',
    type: String,
    nullable: true,
    example: null,
  })
  proposedTime!: string | null;

  @ApiProperty({
    description: '指导主题，1-200 字',
    example: '挑战杯项目选题与打磨',
  })
  topic!: string;

  @ApiProperty({
    description: '拟咨询问题，1-2000 字',
    example: '如何把技术方案讲成一个好故事？',
  })
  questions!: string;

  @ApiProperty({
    description: '对接方式：1 线上 / 2 线下',
    enum: APPOINTMENT_MODES,
    example: 1,
  })
  mode!: number;

  @ApiProperty({
    description:
      '导师处理意见（确认 / 调整时间时填写，存最近一次）；未处理时为 null',
    type: String,
    nullable: true,
    example: null,
  })
  handleComment!: string | null;

  @ApiProperty({
    description: '拒绝原因；未被拒绝时为 null',
    type: String,
    nullable: true,
    example: null,
  })
  rejectReason!: string | null;

  @ApiProperty({
    description:
      '学生异议原因（提异议时填写，1-500 字）；未提异议时为 null。' +
      '与拒绝原因、导师处理意见不是同一件事',
    type: String,
    nullable: true,
    example: null,
  })
  disputeReason!: string | null;

  @ApiProperty({
    description:
      '管理员异议复核意见（adjudicate 时填写，1-500 字）；未复核时为 null。' +
      '与导师处理意见、拒绝原因、学生异议原因都不是同一件事',
    type: String,
    nullable: true,
    example: null,
  })
  adjudicateComment!: string | null;

  @ApiProperty({
    description: '命中的可指导时段 ID（MentorTimeSlot.id，BIGINT 对外字符串）',
    type: String,
    nullable: true,
    example: '1',
  })
  slotId!: string | null;
}
