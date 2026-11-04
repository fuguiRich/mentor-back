import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export class RunSyncDto {
  @ApiPropertyOptional({
    description: '同步模式；不传按增量（没有可用水位时自动退化为全量）',
    enum: ['incremental', 'full'],
    example: 'incremental',
  })
  @IsOptional()
  @IsIn(['incremental', 'full'])
  mode?: 'incremental' | 'full';
}
