import { Module } from '@nestjs/common';
import { SysConfigController } from './config.controller';
import { ConfigRepository } from './config.repository';
import { ConfigService } from './config.service';

/**
 * 命名刻意不叫 `ConfigModule`：`@nestjs/config` 的 ConfigModule 已经占了那个名字，
 * 两者在 app.module.ts 的 import 列表里会撞车。撞车不是编译错误（可以 as 别名），
 * 但读 import 的人要多想一步才知道哪个是环境变量、哪个是业务配置表。
 */
@Module({
  controllers: [SysConfigController],
  providers: [ConfigService, ConfigRepository],
  exports: [ConfigService],
})
export class SysConfigModule {}
