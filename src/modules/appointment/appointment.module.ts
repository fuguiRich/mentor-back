import { Module } from '@nestjs/common';
import { SysConfigModule } from '../config/config.module';
import { DataScopeModule } from '../data-scope/data-scope.module';
import { FileModule } from '../file/file.module';
import { UserModule } from '../user/user.module';
import { AppointmentExpiryScheduler } from './appointment-expiry.scheduler';
import { AppointmentController } from './appointment.controller';
import { AppointmentRepository } from './appointment.repository';
import { AppointmentService } from './appointment.service';

/**
 * 预约（Task 23-30）。本模块挂 17 条路由（发起 / 确认 / 拒绝 / 改期 / 取消 /
 * 确认记录 / 提异议 / 异议复核 / 填报重填记录 / 读取记录，Task 29 的
 * 挂预约材料 / 挂过程材料 / 列材料 / 摘预约材料 / 摘过程材料，以及 Task 30 的
 * 预约列表 / 预约详情）。
 *
 * 依赖 `UserModule`（身份链第 1 步按 `userId` 取 `username`）、`DataScopeModule`
 * （解析 `@DataScope` 天花板）、`SysConfigModule`（超时扫描读
 * `appointment.pending_ttl_hours`）与 `FileModule`（Task 29 的
 * `assertOwnedBy` / 文件元数据只读）——都不成环。`SyncPerson` / `MentorProfile` /
 * `MentorTimeSlot` / `SysFile` 的**只读**在 `AppointmentRepository` 里；写只有
 * `Appointment` / `AppointmentMaterial` / `GuidanceRecord` / `GuidanceMaterial`
 * 这几张业务表。
 *
 * `AppointmentExpiryScheduler` 只是 `expireOverdue()` 的定时调用者，是否启动
 * 由 `app.appointmentExpiry.enabled` 决定（`NODE_ENV=test` 默认关）。
 */
@Module({
  imports: [UserModule, DataScopeModule, SysConfigModule, FileModule],
  controllers: [AppointmentController],
  providers: [
    AppointmentService,
    AppointmentRepository,
    AppointmentExpiryScheduler,
  ],
  exports: [AppointmentService],
})
export class AppointmentModule {}
