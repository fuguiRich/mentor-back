import { Module } from '@nestjs/common';
import { DataScopeModule } from '../data-scope/data-scope.module';
import { UserModule } from '../user/user.module';
import { MessageController } from './message.controller';
import { MessageRepository } from './message.repository';
import { MessageService } from './message.service';

/**
 * 消息 / 提醒 / 工作进度（P5 Task 58 / §4.5）。
 *
 * 写只有 `message` 一张表；工作进度对预约 / 考核只读。
 * 依赖 `UserModule`（数据范围要取调用者部门）与 `DataScopeModule`。
 */
@Module({
  imports: [UserModule, DataScopeModule],
  controllers: [MessageController],
  providers: [MessageService, MessageRepository],
})
export class MessageModule {}
