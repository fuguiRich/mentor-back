import { Injectable, Logger } from '@nestjs/common';
import { redisKeys } from '../redis/redis-keys';
import { RedisService } from '../redis/redis.service';

export interface RateLimitDecision {
  allowed: boolean;
  /** 本窗口内还能发几次（已计入本次） */
  remaining: number;
  /** 窗口还剩多少秒重置 */
  resetSeconds: number;
}

/**
 * 固定窗口限流。**故意不做成滑动窗口**：滑动窗口的正确实现要么开有序集合、
 * 要么存时间戳数组，两者都比一个计数器贵好几倍，而限流要的是「挡住突发」，
 * 不是「精确到秒的账」。窗口边界上的瞬时双倍放行是这个取舍的已知代价。
 *
 * 计数与设 TTL 必须在同一个 Lua 脚本里：分开发 `INCR` 再 `EXPIRE`，
 * 中间那一次连接断掉就会留下一个**永不过期**的键，把这个人永久封号，
 * 且没有任何机制会报警——那比限流本身糟糕得多。
 */
const CONSUME_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return { count, ttl }
`;

@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(private readonly redis: RedisService) {}

  /** 消耗一次配额。Redis 挂掉时**放行**——限流是防护，不该变成单点故障 */
  async consume(
    identity: string,
    endpoint: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitDecision> {
    try {
      const result = (await this.redis.client.eval(
        CONSUME_SCRIPT,
        1,
        redisKeys.rateLimit.window(identity, endpoint),
        String(windowSeconds),
      )) as [number, number];

      const count = Number(result[0]);
      const ttl = Number(result[1]);

      return {
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        // TTL 为 -1 表示键没有过期时间（理论上不该出现，脚本已设过）；
        // 为 -2 表示键刚被回收。两种都按整窗长度报，客户端照此重试不会出错。
        resetSeconds: ttl > 0 ? ttl : windowSeconds,
      };
    } catch (error) {
      this.logger.warn(
        `限流计数失败，本次放行：${error instanceof Error ? error.message : String(error)}`,
      );
      return { allowed: true, remaining: limit, resetSeconds: windowSeconds };
    }
  }
}
