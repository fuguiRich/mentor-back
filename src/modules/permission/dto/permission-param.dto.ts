import { ApiProperty } from '@nestjs/swagger';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

export class PermissionParamDto {
  @ApiProperty({ description: '权限点 ID', example: '1' })
  @IsBigIntId({ message: '权限点 ID 必须是合法的数字 ID' })
  id!: string;
}
