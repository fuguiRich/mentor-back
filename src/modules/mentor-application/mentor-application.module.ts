import { Module } from '@nestjs/common';
import { DataScopeModule } from '../data-scope/data-scope.module';
import { MentorModule } from '../mentor/mentor.module';
import { OpLogModule } from '../oplog/oplog.module';
import { UserModule } from '../user/user.module';
import { MentorApplicationController } from './mentor-application.controller';
import { MentorApplicationRepository } from './mentor-application.repository';
import { MentorApplicationService } from './mentor-application.service';
import { ReviewService } from './review.service';

/**
 * 入驻申请（Task 13：提交；Task 14 起审核 / 读入口、Task 15 起 type=2 都挂这里）。
 *
 * 依赖 UserModule / DataScopeModule 与 mentor.module.ts 同理、同方向
 * （user → data-scope，不反向，不会成环）：身份链第 1 步按 `userId` 取
 * `username` 走 `UserService.findById`，数据范围天花板由 DataScopeModule 解析。
 *
 * `SyncPerson` 的**只读**在 `MentorApplicationRepository` 里（身份链第 2 步）——
 * SyncModule 只导出同步任务；写仍被扩展的 `SYNC_WRITE_FORBIDDEN = 30101` 拒掉。
 * `src/modules/mentor/` 只**用**不改：键名翻译经 MentorModule 导出的
 * `MentorMapperProvider` 注入复用（LAYER-06，R68）。
 *
 * `OpLogModule` 是 Task 14 的审核留痕（brief §0.4）：它已 `exports: [OpLogService]`，
 * 这里 `imports: [OpLogModule]` 然后构造注入——**不许** `import '../oplog/oplog.service'`
 * 伸手进别个模块的内部文件（LAYER-06，R71 的教训；file.module.ts 同款接法）。
 */
@Module({
  imports: [UserModule, DataScopeModule, MentorModule, OpLogModule],
  controllers: [MentorApplicationController],
  providers: [
    MentorApplicationService,
    ReviewService,
    MentorApplicationRepository,
  ],
  exports: [MentorApplicationService],
})
export class MentorApplicationModule {}
