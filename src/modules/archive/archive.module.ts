import { Module } from '@nestjs/common';
import { SysConfigModule } from '../config/config.module';
import { DataScopeModule } from '../data-scope/data-scope.module';
import { UserModule } from '../user/user.module';
import { ArchiveController } from './archive.controller';
import { ArchivePurgeScheduler } from './archive-purge.scheduler';
import { ArchiveRepository } from './archive.repository';
import { ArchiveService } from './archive.service';

/**
 * 归档（P4 Task 52 / §4.7）。
 *
 * 写只有 `archive_item` 一张表；两个审核通过点的自动归档在各自的模块里、
 * 与审核同一事务完成（R66），本模块不反向依赖它们。
 */
@Module({
  imports: [UserModule, DataScopeModule, SysConfigModule],
  controllers: [ArchiveController],
  providers: [ArchiveService, ArchiveRepository, ArchivePurgeScheduler],
})
export class ArchiveModule {}
