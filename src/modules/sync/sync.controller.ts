import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Put,
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
import { SsoSyncScheduler } from './sso/sso-sync.scheduler';
import { SsoSyncSource } from './sso/sso-sync.source';
import { SyncSettingsService } from './sso/sync-settings.service';
import { QuerySyncRunDto } from './dto/query-sync-run.dto';
import { RunSyncDto } from './dto/run-sync.dto';
import { SyncRunPageResponseDto } from './dto/sync-run-page-response.dto';
import { SyncScheduleResponseDto } from './dto/sync-schedule-response.dto';
import { UpdateSyncScheduleDto } from './dto/update-sync-schedule.dto';
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
    private readonly settings: SyncSettingsService,
    private readonly scheduler: SsoSyncScheduler,
  ) {}

  @Get('schedule')
  @RequirePermission('sync:manage')
  @ApiOperation({
    summary: '查看 SSO 定时同步设置与运行状态',
    description:
      '返回当前启停、间隔、是否同步学生、是否有任务在跑、下次触发时间和最近一条流水。',
  })
  @ApiOkResponse({ type: SyncScheduleResponseDto })
  async getSchedule(): Promise<SyncScheduleResponseDto> {
    const [settings, lastRun] = await Promise.all([
      this.settings.getSettings(),
      this.runs.findLatest('sso'),
    ]);
    return {
      ...this.scheduler.getStatus(),
      ...settings,
      lastRun: lastRun === null ? null : toSyncRunResponse(lastRun),
    };
  }

  @Put('schedule')
  @RequirePermission('sync:manage')
  @ApiOperation({
    summary: '修改 SSO 定时同步设置',
    description:
      '只传要改的字段；写数据库后立即重新排期。间隔单位是秒，' +
      '`intervalSeconds` 最小 60，`fullIntervalSeconds` 最小 3600。',
  })
  @ApiOkResponse({ type: SyncScheduleResponseDto })
  async updateSchedule(
    @Body() dto: UpdateSyncScheduleDto,
  ): Promise<SyncScheduleResponseDto> {
    await this.settings.updateSettings(dto);
    await this.scheduler.reschedule();
    return this.getSchedule();
  }

  @Post('sso/run')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('sync:run')
  @ApiOperation({
    summary: '手动触发一次 SSO 同步',
    description:
      '立即开一条 RUNNING 流水并返回 runId，同步在后台执行——全量同步可能超过网关超时，' +
      '不能同步等待。用 `GET /sync/runs` 查状态。',
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

    const settings = await this.settings.getSettings();
    this.source.setStudentsEnabled(settings.studentsEnabled);
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
