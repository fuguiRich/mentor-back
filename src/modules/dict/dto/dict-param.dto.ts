import { ApiProperty } from '@nestjs/swagger';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

export class DictTypeParamDto {
  @ApiProperty({ description: '字典类型 ID', example: '1' })
  @IsBigIntId({ message: '字典类型 ID 必须是合法的数字 ID' })
  id!: string;
}

export class DictItemParamDto {
  @ApiProperty({ description: '字典项 ID', example: '1' })
  @IsBigIntId({ message: '字典项 ID 必须是合法的数字 ID' })
  id!: string;
}
