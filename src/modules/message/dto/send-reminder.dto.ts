import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsIn, IsOptional } from 'class-validator';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';
import { REMINDER_TYPES, type ReminderType } from './message-response.dto';

/**
 * `POST /reminders` 的请求体（P5 Task 58 / §4.5）。
 *
 * `mentorProfileIds` 省略 = 对**范围内所有计数 > 0** 的导师发；
 * 给了就只发这些导师，且任何一个不在数据范围内 → **403 / 10003**
 * （不是静默跳过：管理员以为发了，实际没发，是最坏的失败模式）。
 */
export class SendReminderDto {
  @ApiProperty({
    description:
      '提醒类型：pending-appointments 预约待处理 / record-missing 记录待填 / ' +
      'assessment-pending 考核待处理',
    enum: REMINDER_TYPES,
    example: 'pending-appointments',
  })
  @IsIn([...REMINDER_TYPES], {
    message: `type 只能是 ${REMINDER_TYPES.join(' / ')}`,
  })
  type!: ReminderType;

  @ApiPropertyOptional({
    description: '只给这些导师发（MentorProfile.id，BIGINT 对外字符串）',
    type: [String],
    example: ['3', '4'],
  })
  @IsOptional()
  @IsArray({ message: 'mentorProfileIds 必须是数组' })
  @IsBigIntId({ each: true, message: 'mentorProfileIds 必须是数字 ID 数组' })
  mentorProfileIds?: string[];
}
