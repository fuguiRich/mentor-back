import { Module } from '@nestjs/common';
import { DataScopeModule } from '../data-scope/data-scope.module';
import { FileModule } from '../file/file.module';
import { UserModule } from '../user/user.module';
import { AchievementController } from './achievement.controller';
import { AchievementRepository } from './achievement.repository';
import { AchievementService } from './achievement.service';

/**
 * 双创成果（P3 Task 36）。本模块挂 **4 条路由**，全在 `/mentors` 前缀下。
 *
 * 依赖 `UserModule`（身份链第 1 步）与 `DataScopeModule`（管理员按部门看）。
 * 写只有 `achievement` 一张表；`mentor_profile` / `sync_person` 只读。
 */
@Module({
  imports: [UserModule, DataScopeModule, FileModule],
  controllers: [AchievementController],
  providers: [AchievementService, AchievementRepository],
})
export class AchievementModule {}
