import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SyncRunResponseDto } from './sync-run-response.dto';

export class SyncScheduleResponseDto {
  @ApiProperty({ description: '是否启用定时同步', example: true })
  enabled!: boolean;

  @ApiProperty({ description: '同步间隔（秒）', example: 21600 })
  intervalSeconds!: number;

  @ApiProperty({ description: '全量同步间隔（秒）', example: 604800 })
  fullIntervalSeconds!: number;

  @ApiProperty({ description: '是否同步学生', example: false })
  studentsEnabled!: boolean;

  @ApiProperty({ description: '当前是否有同步在跑', example: false })
  running!: boolean;

  @ApiPropertyOptional({
    type: String,
    description: '下次触发时间（UTC ISO 8601）；关闭时为空',
    nullable: true,
  })
  nextRunAt!: string | null;

  @ApiPropertyOptional({
    type: SyncRunResponseDto,
    description: '最近一条流水；从未跑过时为空',
    nullable: true,
  })
  lastRun!: SyncRunResponseDto | null;
}
