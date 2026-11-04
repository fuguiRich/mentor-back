import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class QuerySyncRunDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '数据源标识，如 sso；不传表示全部来源',
    example: 'sso',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  source?: string;
}
