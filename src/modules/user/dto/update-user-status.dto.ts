import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn } from 'class-validator';

export class UpdateUserStatusDto {
  @ApiProperty({
    description:
      '目标状态：1 启用 / 0 停用。停用会作废该用户全部已签发令牌（R14）；' +
      '启用不会。超管账号不可停用（R7④，回 21105）。',
    example: 1,
    enum: [1, 0],
  })
  @Type(() => Number)
  @IsIn([1, 0], { message: '状态只能是 1（启用）或 0（停用）' })
  status!: number;
}
