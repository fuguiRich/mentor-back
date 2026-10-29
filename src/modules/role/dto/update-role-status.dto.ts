import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn } from 'class-validator';

export class UpdateRoleStatusDto {
  @ApiProperty({
    description: '目标状态：1 启用 / 0 停用',
    example: 1,
    enum: [1, 0],
  })
  @Type(() => Number)
  @IsIn([1, 0], { message: '状态只能是 1（启用）或 0（停用）' })
  status!: number;
}
