import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../../config/configuration';
import { redisKeys } from '../../../infra/redis/redis-keys';
import { RedisService } from '../../../infra/redis/redis.service';
import { SyncRunRepository } from '../sync-run.repository';
import { SyncService } from '../sync.service';
import { SsoSyncSource } from './sso-sync.source';

/** 分布式锁的 TTL：覆盖一次全量同步的最长预期时间 */
const LOCK_TTL_SECONDS = 3600;
/** 启动后等一会儿再跑首次同步，别和启动期的迁移/预热抢资源 */
const STARTUP_DELAY_MS = 30_000;

/**
 * SSO 定时同步的**定时器外壳**。
 *
 * 与预约超时扫描同一个写法：模块内 `setInterval`，不引入 `@nestjs/schedule`。
 * 同步逻辑本身在 `SyncService.runOnce()`，这里只决定「什么时候跑、全量还是增量」。
 *
 * 多实例必须用 Redis 锁：两个副本同时跑全量会重复消耗 SSO 配额，
 * 而且离场两笔写不是事务，互相覆盖会产生不可自愈的中间态。
 */
@Injectable()
export class SsoSyncScheduler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SsoSyncScheduler.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly fullIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sync: SyncService,
    private readonly source: SsoSyncSource,
    private readonly runs: SyncRunRepository,
    private readonly redis: RedisService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.enabled = config.getOrThrow('sso.syncEnabled', { infer: true });
    this.intervalMs =
      config.getOrThrow('sso.syncIntervalSeconds', { infer: true }) * 1000;
    this.fullIntervalMs =
      config.getOrThrow('sso.syncFullIntervalSeconds', { infer: true }) * 1000;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      return;
    }

    this.startupTimer = setTimeout(() => {
      void this.tick();
    }, STARTUP_DELAY_MS);
    this.startupTimer.unref();

    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref();

    this.logger.log(
      `SSO 定时同步已启动：每 ${this.intervalMs / 1000} 秒一次，` +
        `全量间隔 ${this.fullIntervalMs / 1000} 秒`,
    );
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.startupTimer !== null) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  private async tick(): Promise<void> {
    const lockKey = redisKeys.sso.syncLock();
    const acquired = await this.redis.client.set(
      lockKey,
      '1',
      'EX',
      LOCK_TTL_SECONDS,
      'NX',
    );
    if (acquired === null) {
      this.logger.debug('另一个实例正在同步，跳过本次触发');
      return;
    }

    try {
      const mode = await this.decideMode();
      const result = await this.sync.runOnce(this.source, { mode });
      this.logger.log(
        `SSO 同步完成：run=${result.runId} mode=${result.mode} ` +
          `status=${result.status} total=${result.total} fail=${result.failCount}`,
      );
    } catch (error: unknown) {
      this.logger.error(
        'SSO 同步失败，下个周期重试',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      await this.redis.client.del(lockKey);
    }
  }

  private async decideMode(): Promise<'incremental' | 'full'> {
    const lastFull = await this.runs.findLastFinishedByMode('sso', 'full');
    if (lastFull === null) {
      return 'full';
    }
    return Date.now() - lastFull.getTime() >= this.fullIntervalMs
      ? 'full'
      : 'incremental';
  }
}
