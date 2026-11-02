import { ApiProperty } from '@nestjs/swagger';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

/**
 * `GET /mentors/:mentorId/reviews` 的路径参数。
 *
 * `:mentorId` 是 `MentorProfile.id`（**不是** `SyncPerson.id`，也不是 `SysUser.id`）——
 * 与检索页返回的 `id`、预约发起时用的 `mentorProfileId` 同一个值。
 */
export class MentorReviewParamDto {
  @ApiProperty({
    description: '导师档案 ID（MentorProfile.id，BIGINT 对外字符串）',
    example: '1',
  })
  @IsBigIntId({ message: '导师 ID 必须是合法的数字 ID' })
  mentorId!: string;
}
