import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class QueryDeptDto {
  @ApiPropertyOptional({
    description:
      '按部门名称模糊筛选；匹配到的节点若其父不在结果集中，会被提升为根节点',
    example: '信息',
  })
  @IsOptional()
  @IsString()
  name?: string;
}
