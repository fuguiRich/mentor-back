import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

export class UpdateSyncScheduleDto {
  @ApiPropertyOptional({ description: '是否启用定时同步', example: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description: '同步间隔（秒），最小 60',
    example: 21600,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(60)
  intervalSeconds?: number;

  @ApiPropertyOptional({
    description: '全量同步间隔（秒），最小 3600',
    example: 604800,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(3600)
  fullIntervalSeconds?: number;

  @ApiPropertyOptional({
    description: '是否同步学生；缺 edu:classes 能力键时置 false',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  studentsEnabled?: boolean;
}
