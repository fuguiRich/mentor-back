import { Module } from '@nestjs/common';
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

/**
 * 同步模块。定时器（`SsoSyncScheduler`）与手动触发入口（`SyncController`）
 * 都在这里；`PrismaService` 不用 import——`PrismaModule` 是 `@Global()` 的。
 */
@Module({
  controllers: [SyncController],
  providers: [
    SyncRunRepository,
    SyncOrgRepository,
    SyncPersonRepository,
    ProjectionWriter,
    SyncService,
    SsoUserProvisioner,
    {
      provide: SsoOpenApiClient,
      // 第二个参数是测试注入的 fetch；工厂避开 Nest 把它当依赖解析
      useFactory: (config: ConfigService) => new SsoOpenApiClient(config as never),
      inject: [ConfigService],
    },
    SsoSyncSource,
    SsoSyncScheduler,
  ],
  exports: [SyncService, SsoUserProvisioner, SsoOpenApiClient, SsoSyncSource],
})
export class SyncModule {}
