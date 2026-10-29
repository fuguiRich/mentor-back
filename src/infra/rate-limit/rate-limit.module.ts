import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { RateLimitService } from './rate-limit.service';

/**
 * 只提供计数服务。**APP_GUARD 注册在 AuthModule 里**，跟 JwtAuthGuard /
 * PermissionGuard 排在同一个 providers 数组里——顺序由那个数组的文字顺序钉死，
 * 而不是靠「哪个模块先被 import」这种没人看得见的隐式约定。
 * 见 rate-limit.guard.ts 顶部关于「为什么必须排在鉴权之后」的说明。
 */
@Module({
  imports: [RedisModule],
  providers: [RateLimitService],
  exports: [RateLimitService],
})
export class RateLimitModule {}
