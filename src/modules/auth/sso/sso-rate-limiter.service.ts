import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../../config/configuration';
import { redisKeys } from '../../../infra/redis/redis-keys';
import { RedisService } from '../../../infra/redis/redis.service';
import { SsoApiError } from './sso-error';

/** 固定窗口长度：与 SSO 文档的「每分钟 60 次」对齐 */
const WINDOW_SECONDS = 60;

/**
 * SSO api-login 的应用级令牌桶。
 *
 * SSO 文档写明「单应用每分钟最多 60 次」。如果不在这里先挡一道，随机用户名
 * 就能把配额打满，合法用户只能拿到 20110——这是对登录入口的廉价 DoS。
 * 放在 Redis 而不是进程内存：多副本部署时额度必须共享，否则每个副本
 * 各算各的，实际调用量是配置值的 N 倍。
 */
@Injectable()
export class SsoRateLimiter {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async consume(): Promise<void> {
    const appId = this.config.getOrThrow('sso.appId', { infer: true });
    const limit = this.config.getOrThrow('sso.rateLimitPerMinute', {
      infer: true,
    });
    const key = redisKeys.sso.rateLimit(appId);

    const count = await this.redis.client.incr(key);
    if (count === 1) {
      await this.redis.client.expire(key, WINDOW_SECONDS);
    }
    if (count > limit) {
      throw new SsoApiError(
        'rate_limited',
        `SSO 本地令牌桶已满：${count}/${limit} 每分钟`,
      );
    }
  }
}
