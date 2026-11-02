import { ApiProperty } from '@nestjs/swagger';

/** 消息类型：1 预约待处理 / 2 指导记录待填写 / 3 考核待处理 */
export const MESSAGE_TYPES = [1, 2, 3] as const;

/** 提醒类型（发提醒接口的入参） */
export const REMINDER_TYPES = [
  'pending-appointments',
  'record-missing',
  'assessment-pending',
] as const;

export type ReminderType = (typeof REMINDER_TYPES)[number];

/** 一条站内消息的响应形状 */
export class MessageResponseDto {
  @ApiProperty({ description: '消息 ID（BIGINT 对外字符串）', example: '1' })
  id!: string;

  @ApiProperty({
    description: '消息类型：1 预约待处理 / 2 指导记录待填写 / 3 考核待处理',
    enum: MESSAGE_TYPES,
    example: 1,
  })
  type!: number;

  @ApiProperty({ description: '标题', example: '预约待处理提醒' })
  title!: string;

  @ApiProperty({
    description: '正文',
    example: '您有 2 条预约待确认，请及时处理。',
  })
  content!: string;

  @ApiProperty({
    description: '关联业务对象类型（弱关联）',
    type: String,
    nullable: true,
    example: 'MentorProfile',
  })
  bizType!: string | null;

  @ApiProperty({
    description: '关联业务对象 ID（弱关联）',
    type: String,
    nullable: true,
    example: '3',
  })
  bizId!: string | null;

  @ApiProperty({
    description: '已读时刻（ISO 8601）；未读为 null',
    type: String,
    nullable: true,
    example: null,
  })
  readAt!: string | null;

  @ApiProperty({
    description: '创建时间（ISO 8601）',
    example: '2026-11-02T02:00:00.000Z',
  })
  createdAt!: string;
}

/** `GET /messages` 的响应 */
export class MessageListResponseDto {
  @ApiProperty({ description: '当前页消息', type: [MessageResponseDto] })
  list!: MessageResponseDto[];

  @ApiProperty({ description: '总条数', example: 3 })
  total!: number;

  @ApiProperty({ description: '当前页码', example: 1 })
  page!: number;

  @ApiProperty({ description: '每页条数', example: 20 })
  pageSize!: number;

  @ApiProperty({
    description: '当前用户的未读总数（不受分页影响）',
    example: 2,
  })
  unread!: number;
}
