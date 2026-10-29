import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class QueryDictTypeDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '字典类型编码，模糊匹配',
    example: 'gen',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: '字典类型编码长度不能超过 50 个字符' })
  code?: string;

  @ApiPropertyOptional({
    description: '字典类型名称，模糊匹配',
    example: '性别',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: '字典类型名称长度不能超过 50 个字符' })
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
