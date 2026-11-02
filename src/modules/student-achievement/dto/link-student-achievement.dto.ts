import { ApiProperty } from '@nestjs/swagger';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

/** `PATCH /student-achievements/:id/link` 的请求体（人工关联，P5-R3） */
export class LinkStudentAchievementDto {
  @ApiProperty({
    description: '关联的导师档案 ID（MentorProfile.id，BIGINT 对外字符串）',
    example: '1',
  })
  @IsBigIntId({ message: 'mentorProfileId 必须是合法的数字 ID' })
  mentorProfileId!: string;
}
