import { ApiProperty } from '@nestjs/swagger';
import { IsArray } from 'class-validator';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

export class AssignRolePermissionsDto {
  @ApiProperty({
    description:
      '目标权限点 ID 的**完整**集合（全量覆盖，不是增量）：' +
      '请求里没有的会被撤销，请求里有而库里没有的会被新增。' +
      '传 [] 表示清空该角色的全部权限。数组内的重复 ID 会被去重。',
    type: [String],
    example: ['1', '2', '3'],
  })
  @IsArray({ message: 'permissionIds 必须是数组' })
  @IsBigIntId({ each: true, message: '权限点 ID 必须是合法的数字 ID' })
  permissionIds!: string[];
}
