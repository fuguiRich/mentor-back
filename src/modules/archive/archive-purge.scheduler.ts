import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ARCHIVE_PURGE_ENABLED_CODE } from './archive.constants';
import { ArchiveService } from './archive.service';
import { ConfigService as SysConfigService } from '../config/config.service';

/** 过期清理的扫描间隔：一天一次。保留期是「日期」粒度，更频繁没有意义。 */
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 过期清理的**定时器外壳**（P4 Task 53 / R65）。
 *
 * 与 `AppointmentExpiryScheduler` 同一套做法：扫描逻辑在
 * `ArchiveService.purge()`，这里只负责按间隔调它——e2e 可以直调方法，
 * 不必等定时器，也不必为了测试把间隔调到毫秒级。
 *
 * **开关是 `SysConfig` 的 `archive.purge_enabled`，默认关**（生产先人工跑）：
 * 清理会软删行，自动跑之前先让管理员手工验一次。配置取不到（不存在 / 已停用）
 * 一律按「关」处理——这是可缺省的运行期参数，不该把进程启动打断。
 *
 * **测试里不会启动**：`NODE_ENV === 'test'` 时直接返回，e2e 的库态必须确定。
 * `unref()` 让定时器不拖住进程退出，`onApplicationShutdown` 清掉它。
 */
@Injectable()
export class ArchivePurgeScheduler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ArchivePurgeScheduler.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly archives: ArchiveService,
    private readonly sysConfig: SysConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    const enabled = await this.sysConfig.getString(
      ARCHIVE_PURGE_ENABLED_CODE,
      '0',
    );
    if (!['1', 'true', 'yes', 'on'].includes(enabled.trim().toLowerCase())) {
      return;
    }

    this.timer = setInterval(() => {
      void this.scan();
    }, PURGE_INTERVAL_MS);
    this.timer.unref();
    this.logger.log(
      `归档过期清理已启动：每 ${PURGE_INTERVAL_MS / 1000} 秒一次`,
    );
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 定时触发一次清理。失败不能抛回定时器回调（会成为未处理的 Promise rejection） */
  private async scan(): Promise<void> {
    try {
      const { purged } = await this.archives.purge();
      if (purged > 0) {
        this.logger.log(`归档过期清理：${purged} 条 → 软删`);
      }
    } catch (error: unknown) {
      this.logger.error(
        '归档过期清理失败，下个周期重试',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
