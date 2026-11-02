import { Module } from '@nestjs/common';
import { DataScopeModule } from '../data-scope/data-scope.module';
import { UserModule } from '../user/user.module';
import { MentorSlotController } from './mentor-slot.controller';
import { MentorSlotRepository } from './mentor-slot.repository';
import { MentorSlotService } from './mentor-slot.service';

/**
 * 导师可指导时段（Task 21）。
 *
 * 依赖 `UserModule` 是「sys_user 归 user 模块」的边界：身份链第 1 步按
 * `userId` 取 `username` 走 `UserService.findById`，不在本模块直接读
 * `sys_user` 的表。`DataScopeModule` 解析 `@DataScope('self')` 天花板
 * （user → data-scope 的同一方向，不反向，不会成环）。
 *
 * `SyncPerson` / `MentorProfile` 的**只读**在 `MentorSlotRepository` 里
 * （身份链第 2、3 步）——同 mentor-material 的口径；写仍被扩展的
 * `SYNC_WRITE_FORBIDDEN = 30101` 拒掉，本模块对同步表一条写路径都没有。
 */
@Module({
  imports: [UserModule, DataScopeModule],
  controllers: [MentorSlotController],
  providers: [MentorSlotService, MentorSlotRepository],
  exports: [MentorSlotService],
})
export class MentorSlotModule {}
