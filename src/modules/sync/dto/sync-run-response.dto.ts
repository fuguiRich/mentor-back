import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { SyncRun } from '@prisma/client';

export class SyncRunResponseDto {
  @ApiProperty({ description: '流水 ID', example: '1' })
  id!: string;

  @ApiProperty({ description: '数据源标识', example: 'sso' })
  source!: string;

  @ApiPropertyOptional({
    description: '本次跑的模式：incremental / full；历史行可能为空',
    enum: ['incremental', 'full'],
    nullable: true,
  })
  mode!: 'incremental' | 'full' | null;

  @ApiProperty({
    description: '0 RUNNING / 1 OK / 2 PARTIAL / 3 FAILED',
    example: 1,
  })
  status!: number;

  @ApiProperty({ description: '开始时间（UTC ISO 8601）' })
  startedAt!: string;

  @ApiPropertyOptional({
    description: '结束时间（UTC ISO 8601）；RUNNING 时为空',
    nullable: true,
  })
  finishedAt!: string | null;

  @ApiProperty({ description: '本次处理的总行数', example: 100 })
  total!: number;

  @ApiProperty({ description: '成功行数', example: 98 })
  okCount!: number;

  @ApiProperty({ description: '失败行数', example: 2 })
  failCount!: number;
}

export function toSyncRunResponse(run: SyncRun): SyncRunResponseDto {
  return {
    id: run.id.toString(),
    source: run.source,
    mode:
      run.mode === 'incremental' || run.mode === 'full' ? run.mode : null,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    total: run.total,
    okCount: run.okCount,
    failCount: run.failCount,
  };
}
