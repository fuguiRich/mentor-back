import { ApiProperty } from '@nestjs/swagger';
import { SyncRunResponseDto } from './sync-run-response.dto';

export class SyncRunPageResponseDto {
  @ApiProperty({ type: [SyncRunResponseDto] })
  rows!: SyncRunResponseDto[];

  @ApiProperty({ description: '总条数', example: 42 })
  total!: number;

  @ApiProperty({ description: '页码', example: 1 })
  page!: number;

  @ApiProperty({ description: '每页条数', example: 20 })
  pageSize!: number;
}
