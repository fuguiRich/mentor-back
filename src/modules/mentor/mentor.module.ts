import { Module } from '@nestjs/common';
import { DataScopeModule } from '../data-scope/data-scope.module';
import { OpLogModule } from '../oplog/oplog.module';
import { UserModule } from '../user/user.module';
import { MentorController } from './mentor.controller';
import { MentorMapperProvider } from './mentor-mapper.provider';
import { MentorRepository } from './mentor.repository';
import { MentorService } from './mentor.service';

/**
 * 导师专业档案（Task 11 + 12）。
 *
 * 依赖 UserModule 是「sys_user 归 user 模块」的边界：身份链第 1 步按
 * `userId` 取 `username` 走 `UserService.findById`，不在本模块直接读
 * `sys_user` 的表。DataScopeModule 是数据范围天花板的解析方
 * （user → data-scope 的同一方向，不反向，不会成环）。
 *
 * `SyncPerson` 的**只读**在 `MentorRepository` 里（身份链第 2 步）——
 * SyncModule 只导出同步任务，`src/modules/sync/**` 本任务不动；写仍被
 * 扩展的 `SYNC_WRITE_FORBIDDEN = 30101` 拒掉，本模块一条写路径都没有。
 *
 * `MentorMapperProvider` 是 mapper 的对外导出面（LAYER-06）：mentor-application
 * 经注入复用 `toMentorProfileResponse`（R68 键名翻译只此一张表），不跨模块
 * 直接 import 内部 mapper。
 *
 * `MentorRepository` 也导出（Task 15）：`6 APPROVED` 的生效写回要与申请状态
 * 同一次事务，review.service 注入它调 `updateDraft(id, draft, tx)`——键名翻译
 * 仍在持久层（R68），业务代码不点名 `researchAchievements`。
 *
 * `OpLogModule` 是 Task 18 的后台改档留痕：`PUT /mentor/profiles/:id` 的落库与
 * 留痕同一次事务，`MentorService` 构造注入 `OpLogService`（它已
 * `exports: [OpLogService]`），**不许**跨模块直接 import 内部 service 文件。
 */
@Module({
  imports: [UserModule, DataScopeModule, OpLogModule],
  controllers: [MentorController],
  providers: [MentorService, MentorRepository, MentorMapperProvider],
  exports: [MentorService, MentorRepository, MentorMapperProvider],
})
export class MentorModule {}
