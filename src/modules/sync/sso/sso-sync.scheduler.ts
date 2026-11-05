import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { redisKeys } from '../../../infra/redis/redis-keys';
import { RedisService } from '../../../infra/redis/redis.service';
import { SyncRunRepository } from '../sync-run.repository';
import { SyncService } from '../sync.service';
import { SyncSettingsService } from './sync-settings.service';
import { SsoSyncSource } from './sso-sync.source';

/** 分布式锁的 TTL：覆盖一次全量同步的最长预期时间 */
const LOCK_TTL_SECONDS = 3600;
/** 启动后等一会儿再跑首次同步，别和启动期的迁移/预热抢资源 */
const STARTUP_DELAY_MS = 30_000;
/** 多实例下定期回读数据库配置，让改间隔/启停能传播到其他副本 */
const CONFIG_REFRESH_MS = 60_000;

export interface SsoSyncStatus {
  enabled: boolean;
  intervalSeconds: number;
  fullIntervalSeconds: number;
  studentsEnabled: boolean;
  running: boolean;
  nextRunAt: string | null;
}

/**
 * SSO 定时同步的**定时器外壳**。
 *
 * 配置来源：数据库 `SysConfig` 优先，缺项回退 `SSO_SYNC_*` 环境变量。
 * 管理接口改完配置后调用 {@link reschedule}；其他副本靠 60 秒一次的回读
 * 追上变化。同步逻辑本身在 `SyncService.runOnce()`，这里只决定
 * 「什么时候跑、全量还是增量」。
 */
@Injectable()
export class SsoSyncScheduler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SsoSyncScheduler.name);
  private enabled = false;
  private intervalMs = 6 * 60 * 60 * 1000;
  private fullIntervalMs = 7 * 24 * 60 * 60 * 1000;
  private studentsEnabled = true;
  private running = false;
  private nextRunAt: Date | null = null;
  private timer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sync: SyncService,
    private readonly source: SsoSyncSource,
    private readonly runs: SyncRunRepository,
    private readonly redis: RedisService,
    private readonly settings: SyncSettingsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.applySettings();
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, CONFIG_REFRESH_MS);
    this.refreshTimer.unref();
  }

  onApplicationShutdown(): void {
    this.clearSyncTimers();
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** 管理接口改完配置后调用 */
  async reschedule(): Promise<void> {
    await this.applySettings();
  }

  getStatus(): SsoSyncStatus {
    return {
      enabled: this.enabled,
      intervalSeconds: Math.floor(this.intervalMs / 1000),
      fullIntervalSeconds: Math.floor(this.fullIntervalMs / 1000),
      studentsEnabled: this.studentsEnabled,
      running: this.running,
      nextRunAt: this.nextRunAt?.toISOString() ?? null,
    };
  }

  private async applySettings(): Promise<void> {
    const settings = await this.settings.getSettings();
    this.enabled = settings.enabled;
    this.intervalMs = settings.intervalSeconds * 1000;
    this.fullIntervalMs = settings.fullIntervalSeconds * 1000;
    this.studentsEnabled = settings.studentsEnabled;
    this.source.setStudentsEnabled(settings.studentsEnabled);

    this.clearSyncTimers();
    if (!this.enabled) {
      this.nextRunAt = null;
      this.logger.log('SSO 定时同步已关闭');
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

    this.nextRunAt = new Date(Date.now() + STARTUP_DELAY_MS);
    this.logger.log(
      `SSO 定时同步已启动：每 ${settings.intervalSeconds} 秒一次，` +
        `全量间隔 ${settings.fullIntervalSeconds} 秒，` +
        `学生同步 ${settings.studentsEnabled ? '开启' : '关闭'}`,
    );
  }

  private async refresh(): Promise<void> {
    const settings = await this.settings.getSettings();
    if (
      !settings.enabled ||
      settings.intervalSeconds * 1000 !== this.intervalMs ||
      settings.fullIntervalSeconds * 1000 !== this.fullIntervalMs ||
      settings.studentsEnabled !== this.studentsEnabled
    ) {
      await this.applySettings();
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }

    const settings = await this.settings.getSettings();
    if (!settings.enabled) {
      return;
    }
    this.source.setStudentsEnabled(settings.studentsEnabled);

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

    this.running = true;
    try {
      const mode = await this.decideMode(settings.fullIntervalSeconds * 1000);
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
      this.running = false;
      await this.redis.client.del(lockKey);
      this.nextRunAt = new Date(Date.now() + this.intervalMs);
    }
  }

  private async decideMode(
    fullIntervalMs: number,
  ): Promise<'incremental' | 'full'> {
    const lastFull = await this.runs.findLastFinishedByMode('sso', 'full');
    if (lastFull === null) {
      return 'full';
    }
    return Date.now() - lastFull.getTime() >= fullIntervalMs
      ? 'full'
      : 'incremental';
  }

  private clearSyncTimers(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.startupTimer !== null) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }
}
