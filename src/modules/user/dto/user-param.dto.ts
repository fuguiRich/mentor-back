import { ApiProperty } from '@nestjs/swagger';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

export class UserParamDto {
  @ApiProperty({ description: '用户 ID', example: '1' })
  @IsBigIntId({ message: '用户 ID 必须是合法的数字 ID' })
  id!: string;
}
