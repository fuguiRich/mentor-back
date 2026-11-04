import { Module } from '@nestjs/common';
import { ProjectionWriter } from './projection';
import { SyncOrgRepository } from './sync-org.repository';
import { SyncPersonRepository } from './sync-person.repository';
import { SyncRunRepository } from './sync-run.repository';
import { SyncService } from './sync.service';
import { SsoUserProvisioner } from './sso/sso-user-provisioner';

/**
 * 同步模块。**不带 controller**：同步任务本期没有 HTTP 触发入口，
 * 触发方式（定时任务 / 运维接口）是后面的事，现在只有 `SyncService.runOnce()`。
 *
 * `PrismaService` 不用在这里 import——`PrismaModule` 是 `@Global()` 的。
 */
@Module({
  providers: [
    SyncRunRepository,
    SyncOrgRepository,
    SyncPersonRepository,
    ProjectionWriter,
    SyncService,
    SsoUserProvisioner,
  ],
  exports: [SyncService, SsoUserProvisioner],
})
export class SyncModule {}
