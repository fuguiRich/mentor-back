import { ApiProperty } from '@nestjs/swagger';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

export class DeptParamDto {
  @ApiProperty({ description: '部门 ID', example: '1' })
  @IsBigIntId({ message: '部门 ID 必须是合法的数字 ID' })
  id!: string;
}
