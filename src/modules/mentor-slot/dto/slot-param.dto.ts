import { ApiProperty } from '@nestjs/swagger';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

/**
 * `PUT /mentor/slots/:id` 与 `DELETE /mentor/slots/:id` 的路径参数。
 *
 * `:id` 是 `MentorTimeSlot.id`，库列 BIGINT UNSIGNED、对外一律字符串；
 * 校验用 `@IsBigIntId()`（`1.5` / `-1` / `+1` 与超界都挡在 400，不进 `BigInt()`）。
 */
export class SlotParamDto {
  @ApiProperty({
    description: '可指导时段 ID（BIGINT 对外字符串）',
    example: '1',
  })
  @IsBigIntId({ message: '时段 ID 必须是合法的数字 ID' })
  id!: string;
}
