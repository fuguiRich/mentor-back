import { Module } from '@nestjs/common';
import { SysConfigModule } from '../config/config.module';
import { DataScopeModule } from '../data-scope/data-scope.module';
import { FileModule } from '../file/file.module';
import { UserModule } from '../user/user.module';
import { StudentAchievementController } from './student-achievement.controller';
import { StudentAchievementRepository } from './student-achievement.repository';
import { StudentAchievementService } from './student-achievement.service';

/**
 * 学生成果与人工关联（P5 Task 59 / §5.4）。
 *
 * 写 `student_achievement`，关联事务里另写 `achievement` 与 `archive_item`。
 * 依赖 `UserModule`（身份链）、`DataScopeModule`（学院范围）、
 * `SysConfigModule`（归档保留天数）。
 */
@Module({
  imports: [UserModule, DataScopeModule, SysConfigModule, FileModule],
  controllers: [StudentAchievementController],
  providers: [StudentAchievementService, StudentAchievementRepository],
})
export class StudentAchievementModule {}
