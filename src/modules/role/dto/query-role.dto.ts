import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class QueryRoleDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '角色名称，模糊匹配',
    example: '管理员',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: '角色名称长度不能超过 50 个字符' })
  name?: string;

  @ApiPropertyOptional({
    description: '状态筛选：1 启用 / 0 停用；不传表示全部',
    example: 1,
    enum: [1, 0],
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn([1, 0], { message: '状态只能是 1（启用）或 0（停用）' })
  status?: number;
}
