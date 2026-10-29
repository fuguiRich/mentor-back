import { ApiProperty } from '@nestjs/swagger';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

/**
 * `PUT /mentor/profiles/:id` 的路径参数（Task 18）。
 *
 * `:id` 是 `MentorProfile.id`，库列是 BIGINT UNSIGNED、对外一律字符串；
 * 校验用 `@IsBigIntId()`（`1.5` / `-1` / `+1` 与超界都挡在 400，不进 `BigInt()`）。
 */
export class MentorProfileParamDto {
  @ApiProperty({
    description: '导师专业档案 ID（BIGINT 对外字符串）',
    example: '1',
  })
  @IsBigIntId({ message: '档案 ID 必须是合法的数字 ID' })
  id!: string;
}
