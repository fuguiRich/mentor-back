import { ApiProperty } from '@nestjs/swagger';
import { APPOINTMENT_MODES } from './create-appointment.dto';

/**
 * 指导记录里的「学生信息」（R27）。
 *
 * §3.4 的「填写学生信息」不是请求体字段：它由 `appointment.studentPersonId`
 * 联查 `SyncPerson` 返回，客户端改不到。五个字段与 brief 点名的一致——
 * 姓名 / 学号 / 专业 / 行政班级 / 联系电话。
 */
export class GuidanceRecordStudentDto {
  @ApiProperty({ description: '学生姓名', example: '陈一鸣' })
  realName!: string;

  @ApiProperty({ description: '学号（登录名）', example: 'S001' })
  login!: string;

  @ApiProperty({
    description: '专业；同步数据未提供时为 null',
    type: String,
    nullable: true,
    example: '软件工程',
  })
  major!: string | null;

  @ApiProperty({
    description: '行政班级；同步数据未提供时为 null',
    type: String,
    nullable: true,
    example: '软工 2023-1 班',
  })
  className!: string | null;

  @ApiProperty({
    description: '联系电话；同步数据未提供时为 null',
    type: String,
    nullable: true,
    example: '13800000000',
  })
  mobile!: string | null;
}

/**
 * 一条指导记录的响应形状（RES-04：显式映射，不序列化实体）。
 *
 * 时间字段一律 ISO 8601 字符串（RES-07）；BIGINT 一律对外字符串（RES-08）。
 * `student` 是联查出来的申请人信息（R27），不是记录表的列。
 */
export class GuidanceRecordResponseDto {
  @ApiProperty({
    description: '指导记录行 ID（BIGINT 对外字符串）',
    example: '1',
  })
  id!: string;

  @ApiProperty({
    description: '所属预约 ID（BIGINT 对外字符串）',
    example: '1',
  })
  appointmentId!: string;

  @ApiProperty({
    description: '实际指导时间（ISO 8601）',
    example: '2026-10-30T02:00:00.000Z',
  })
  actualTime!: string;

  @ApiProperty({
    description: '指导方式：1 线上 / 2 线下',
    enum: APPOINTMENT_MODES,
    example: 1,
  })
  mode!: number;

  @ApiProperty({
    description: '核心指导内容，1-5000 字',
    example: '围绕挑战杯选题，梳理了三条可行技术路线并确定主攻方向。',
  })
  coreContent!: string;

  @ApiProperty({
    description: '后续指导建议，1-2000 字',
    example: '下次带原型演示，重点讲清数据来源与评测口径。',
  })
  followUp!: string;

  @ApiProperty({
    description: '提交人（该预约的导师 SyncPerson.id，BIGINT 对外字符串）',
    example: '9',
  })
  submittedBy!: string;

  @ApiProperty({
    description: '提交时间（ISO 8601）',
    example: '2026-10-30T02:05:00.000Z',
  })
  submittedAt!: string;

  @ApiProperty({
    description: '学生信息（由预约的 studentPersonId 联查，R27）',
    type: () => GuidanceRecordStudentDto,
  })
  student!: GuidanceRecordStudentDto;

  @ApiProperty({
    description: '指导时长（分钟）。`0` 表示导师未填——不是「零分钟」（P3 R58）',
    example: 60,
  })
  durationMinutes!: number;
}
