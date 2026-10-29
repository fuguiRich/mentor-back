import { ApiProperty } from '@nestjs/swagger';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

export class RoleParamDto {
  @ApiProperty({ description: '角色 ID', example: '1' })
  @IsBigIntId({ message: '角色 ID 必须是合法的数字 ID' })
  id!: string;
}
