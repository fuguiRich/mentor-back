import { ApiProperty } from '@nestjs/swagger';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

/** `:id` 是 `Message.id`（BIGINT 对外字符串） */
export class MessageParamDto {
  @ApiProperty({
    description: '消息 ID（BIGINT 对外字符串）',
    example: '1',
  })
  @IsBigIntId({ message: '消息 ID 必须是合法的数字 ID' })
  id!: string;
}
