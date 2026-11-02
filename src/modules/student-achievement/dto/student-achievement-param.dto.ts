import { ApiProperty } from '@nestjs/swagger';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

/** `:id` 是 `StudentAchievement.id`（BIGINT 对外字符串） */
export class StudentAchievementParamDto {
  @ApiProperty({
    description: '学生成果 ID（BIGINT 对外字符串）',
    example: '1',
  })
  @IsBigIntId({ message: '学生成果 ID 必须是合法的数字 ID' })
  id!: string;
}
