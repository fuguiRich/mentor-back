import { ApiProperty } from '@nestjs/swagger';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

/** `:mentorId` 是 `MentorProfile.id`（不是 `SyncPerson.id`，也不是 `SysUser.id`） */
export class MentorAchievementParamDto {
  @ApiProperty({
    description: '导师档案 ID（MentorProfile.id，BIGINT 对外字符串）',
    example: '1',
  })
  @IsBigIntId({ message: '导师 ID 必须是合法的数字 ID' })
  mentorId!: string;
}

/** 单条成果的路径参数：`:mentorId` + `:achievementId` */
export class MentorAchievementItemParamDto extends MentorAchievementParamDto {
  @ApiProperty({
    description: '成果行 ID（Achievement.id，BIGINT 对外字符串）',
    example: '1',
  })
  @IsBigIntId({ message: '成果 ID 必须是合法的数字 ID' })
  achievementId!: string;
}
