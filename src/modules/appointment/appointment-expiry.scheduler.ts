import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { AppointmentService } from './appointment.service';

/**
 * 预约超时扫描的**定时器外壳**（Task 25 / R17）。
 *
 * 扫描逻辑本身在 `AppointmentService.expireOverdue()`——这里只负责按间隔调它。
 * 拆开是为了让 e2e 能直接调方法、确定性地验证「跑一次推进 / 再跑一次不动」，
 * 不必等定时器，也不必为了测试把间隔调到毫秒级。
 *
 * **为什么用模块内 `setInterval` 而不是 `@nestjs/schedule`**：
 * 本任务只需要一个固定间隔的任务，引入一个依赖（外加 `ScheduleModule.forRoot()`）
 * 换来的只是装饰器写法；`@nestjs/schedule` 的 cron 表达式在这里也用不上。
 * 代价是少一层「错过触发时的补偿」，但扫描是幂等的、下个周期会补上，不需要。
 *
 * **测试里不会乱跑**：`app.appointmentExpiry.enabled` 不配时按环境走
 * （`NODE_ENV=test` 关、其余开，见 `configuration.ts`），e2e 由 Jest 置
 * `NODE_ENV=test`，定时器根本不会创建。`unref()` 让定时器不拖住进程退出，
 * `onApplicationShutdown` 在 `app.close()` 时清掉它。
 */
@Injectable()
export class AppointmentExpiryScheduler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(AppointmentExpiryScheduler.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly appointments: AppointmentService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.enabled = config.getOrThrow('app.appointmentExpiry.enabled', {
      infer: true,
    });
    this.intervalMs =
      config.getOrThrow('app.appointmentExpiry.intervalSeconds', {
        infer: true,
      }) * 1000;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      return;
    }
    this.timer = setInterval(() => {
      void this.scan();
    }, this.intervalMs);
    this.timer.unref();
    this.logger.log(`预约超时扫描已启动：每 ${this.intervalMs / 1000} 秒一次`);
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 定时触发一次扫描。失败**不能**把异常抛回定时器回调（那会变成未处理的
   * Promise rejection）：记日志，等下个周期重试——扫描是幂等的。
   */
  private async scan(): Promise<void> {
    try {
      const { expired } = await this.appointments.expireOverdue();
      if (expired > 0) {
        // 两条规则都算进来：`0 PENDING` 超 TTL / `1 CONFIRMED` 过约定时间宽限期。
        this.logger.log(`预约超时扫描：${expired} 条 → EXPIRED`);
      }
    } catch (error: unknown) {
      this.logger.error(
        '预约超时扫描失败，下个周期重试',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
