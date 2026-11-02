import { Module } from '@nestjs/common';
import { SysConfigModule } from '../config/config.module';
import { DataScopeModule } from '../data-scope/data-scope.module';
import { UserModule } from '../user/user.module';
import { MeRecordsController } from './me-records.controller';
import { StatsExportController } from './stats-export.controller';
import { StatsController } from './stats.controller';
import { StatsRepository } from './stats.repository';
import { StatsService } from './stats.service';

/**
 * 统计报表（P4 Task 45 起 / §4.1、§4.2、§4.6、§5.3、§6.3、§6.8）。
 *
 * **只读**：`StatsRepository` 只有读方法，本模块不注册任何写路径。
 * 依赖 `UserModule`（身份链）与 `DataScopeModule`（学院只看本院）。
 */
@Module({
  imports: [UserModule, DataScopeModule, SysConfigModule],
  controllers: [StatsController, StatsExportController, MeRecordsController],
  providers: [StatsService, StatsRepository],
})
export class StatsModule {}
