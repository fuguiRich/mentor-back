import { ApiProperty } from '@nestjs/swagger';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

/** `:id` 是 `ArchiveItem.id`（BIGINT 对外字符串） */
export class ArchiveParamDto {
  @ApiProperty({
    description: '归档条目 ID（BIGINT 对外字符串）',
    example: '1',
  })
  @IsBigIntId({ message: '归档 ID 必须是合法的数字 ID' })
  id!: string;
}
