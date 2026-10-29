import { ApiProperty } from '@nestjs/swagger';
import { IsArray } from 'class-validator';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

export class AssignUserRolesDto {
  @ApiProperty({
    description:
      '目标角色 ID 的**完整**集合（全量覆盖，不是增量）：请求里没有的会被撤销，' +
      '请求里有而库里没有的会被新增。传 [] 表示清空该用户的角色。' +
      '数组内的重复 ID 会被去重。每个 ID 都必须存在，否则 22101。',
    type: [String],
    example: ['1', '2'],
  })
  @IsArray({ message: 'roleIds 必须是数组' })
  @IsBigIntId({ each: true, message: '角色 ID 必须是合法的数字 ID' })
  roleIds!: string[];
}
