import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsISO8601, IsInt, IsOptional, Max, Min } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class QueryMentorRecordDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '实际指导时间下界（ISO 8601）',
    example: '2026-01-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    description: '实际指导时间上界（ISO 8601）',
    example: '2026-12-31T23:59:59.999Z',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({
    description:
      '预约类型：1 双创竞赛 / 2 科研项目 / 3 创业实践 / 4 论文专利 / 5 其他',
    example: 1,
    enum: [1, 2, 3, 4, 5],
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  type?: number;
}
