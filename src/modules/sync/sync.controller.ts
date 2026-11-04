import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorCode } from '../../common/constants/error-code';
import { errExample } from '../../common/dto/err-example';
import { BusinessException } from '../../common/errors/business.exception';
import { redisKeys } from '../../infra/redis/redis-keys';
import { RedisService } from '../../infra/redis/redis.service';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { SyncRunRepository } from './sync-run.repository';
import { SyncService } from './sync.service';
import { SsoSyncSource } from './sso/sso-sync.source';
import { QuerySyncRunDto } from './dto/query-sync-run.dto';
import { RunSyncDto } from './dto/run-sync.dto';
import { SyncRunPageResponseDto } from './dto/sync-run-page-response.dto';
import { toSyncRunResponse } from './dto/sync-run-response.dto';

@ApiTags('同步')
@Controller('sync')
export class SyncController {
  private readonly logger = new Logger(SyncController.name);

  constructor(
    private readonly sync: SyncService,
    private readonly source: SsoSyncSource,
    private readonly runs: SyncRunRepository,
    private readonly redis: RedisService,
  ) {}

  @Post('sso/run')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('sync:run')
  @ApiOperation({
    summary: '手动触发一次 SSO 同步',
    description:
      '立即开一条 RUNNING 流水并返回 runId，同步在后台执行——全量同步可能超过网关超时，' +
      '不能同步等待。用 `GET /sync/runs` 查状态。仅超管或持有 `sync:run` 的账号可调。',
  })
  @ApiAcceptedResponse({
    description: '已受理，返回流水 ID',
    schema: { example: { runId: '1' } },
  })
  @ApiForbiddenResponse({
    description: '没有 sync:run 权限',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async runSso(@Body() dto: RunSyncDto): Promise<{ runId: string }> {
    const mode = dto.mode ?? 'incremental';
    const lockKey = redisKeys.sso.syncLock();
    const acquired = await this.redis.client.set(
      lockKey,
      '1',
      'EX',
      3600,
      'NX',
    );
    if (acquired === null) {
      throw new BusinessException(
        ErrorCode.CONFLICT,
        '已有同步任务在运行，请稍后再试',
        HttpStatus.CONFLICT,
      );
    }

    const run = await this.sync.startRun(this.source, { mode });

    void (async () => {
      try {
        await this.sync.executeRun(this.source, run, { mode });
      } catch (error: unknown) {
        this.logger.error(
          `手动同步失败：${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await this.redis.client.del(lockKey);
      }
    })();

    return { runId: run.id.toString() };
  }

  @Get('runs')
  @RequirePermission('sync:run')
  @ApiOperation({
    summary: '查同步流水',
    description:
      '按开始时间倒序返回流水，不返回 `detail`（失败明细可能很大）。' +
      '`source` 不传表示全部来源。',
  })
  @ApiOkResponse({ type: SyncRunPageResponseDto })
  async listRuns(
    @Query() query: QuerySyncRunDto,
  ): Promise<SyncRunPageResponseDto> {
    const { rows, total } = await this.runs.findPage(
      query.source,
      query.page,
      query.pageSize,
    );
    return {
      rows: rows.map(toSyncRunResponse),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
}
