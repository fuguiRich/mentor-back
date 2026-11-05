import { Module } from '@nestjs/common';
import { SysConfigModule } from '../config/config.module';
import { ConfigService } from '@nestjs/config';
import { ProjectionWriter } from './projection';
import { SyncOrgRepository } from './sync-org.repository';
import { SyncPersonRepository } from './sync-person.repository';
import { SyncRunRepository } from './sync-run.repository';
import { SyncService } from './sync.service';
import { SsoUserProvisioner } from './sso/sso-user-provisioner';
import { SsoOpenApiClient } from './sso/sso-open-api.client';
import { SsoSyncSource } from './sso/sso-sync.source';
import { SsoSyncScheduler } from './sso/sso-sync.scheduler';
import { SyncController } from './sync.controller';
import { SyncSettingsService } from './sso/sync-settings.service';
import { SsoRateLimiter } from '../auth/sso/sso-rate-limiter.service';

/**
 * 同步模块。定时器（`SsoSyncScheduler`）与手动触发入口（`SyncController`）
 * 都在这里；`PrismaService` 不用 import——`PrismaModule` 是 `@Global()` 的。
 */
@Module({
  imports: [SysConfigModule],
  controllers: [SyncController],
  providers: [
    SyncRunRepository,
    SyncOrgRepository,
    SyncPersonRepository,
    ProjectionWriter,
    SyncService,
    SsoUserProvisioner,
    SsoRateLimiter,
    {
      provide: SsoOpenApiClient,
      // 第二/第三个参数是测试注入的 fetch 与共享令牌桶；工厂避开 Nest 解析它们
      useFactory: (config: ConfigService, rateLimiter: SsoRateLimiter) =>
        new SsoOpenApiClient(config as never, fetch, rateLimiter),
      inject: [ConfigService, SsoRateLimiter],
    },
    SsoSyncSource,
    SyncSettingsService,
    SsoSyncScheduler,
  ],
  exports: [SyncService, SsoUserProvisioner, SsoOpenApiClient, SsoSyncSource],
})
export class SyncModule {}
