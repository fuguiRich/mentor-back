import type { RedisService } from '../redis/redis.service';
import { RateLimitService } from './rate-limit.service';

function build(evalImpl: () => Promise<unknown>): {
  service: RateLimitService;
  keys: string[];
  args: unknown[][];
} {
  const keys: string[] = [];
  const args: unknown[][] = [];
  const redis = {
    client: {
      eval: (
        script: string,
        keyCount: number,
        key: string,
        window: string,
      ): Promise<unknown> => {
        keys.push(key);
        args.push([script, keyCount, window]);
        return evalImpl();
      },
    },
  } as unknown as RedisService;
  return { service: new RateLimitService(redis), keys, args };
}

describe('RateLimitService', () => {
  it('1. count ≤ limit → 放行，remaining = limit - count', async () => {
    const { service } = build(() => Promise.resolve([3, 60]));

    await expect(service.consume('u:1', 'A.b', 5, 60)).resolves.toEqual({
      allowed: true,
      remaining: 2,
      resetSeconds: 60,
    });
  });

  it('2. count > limit → 拒绝，remaining 不为负', async () => {
    const { service } = build(() => Promise.resolve([7, 60]));

    await expect(service.consume('u:1', 'A.b', 5, 60)).resolves.toEqual({
      allowed: false,
      remaining: 0,
      resetSeconds: 60,
    });
  });

  it('3. 第 limit 次恰好放行（边界是 ≤ 不是 <）', async () => {
    const { service } = build(() => Promise.resolve([5, 42]));

    await expect(service.consume('u:1', 'A.b', 5, 60)).resolves.toEqual({
      allowed: true,
      remaining: 0,
      resetSeconds: 42,
    });
  });

  it('4. Redis 抛错 → **放行**，不抛给调用方（限流不该成为单点故障）', async () => {
    // 反过来（fail-closed）会让一次 Redis 抖动把全校登录打死，
    // 而限流要挡的是恶意突发，不是正常访问。
    const { service } = build(() =>
      Promise.reject(new Error('connection refused')),
    );

    await expect(service.consume('u:1', 'A.b', 5, 60)).resolves.toEqual({
      allowed: true,
      remaining: 5,
      resetSeconds: 60,
    });
  });

  it('5. 键里带上身份与端点，不同人 / 不同端点互不影响', async () => {
    const { service, keys } = build(() => Promise.resolve([1, 60]));

    await service.consume('u:1', 'A.b', 5, 60);
    await service.consume('u:2', 'A.b', 5, 60);
    await service.consume('u:1', 'C.d', 5, 60);

    expect(keys).toEqual(['rl:u:1:A.b', 'rl:u:2:A.b', 'rl:u:1:C.d']);
  });

  it('6. TTL 异常（-1 无过期 / -2 已回收）→ 按整窗长度报，不报负数', async () => {
    // 负的 resetSeconds 会让客户端算出过去的时间戳，重试逻辑直接乱套。
    const noTtl = build(() => Promise.resolve([1, -1]));
    await expect(noTtl.service.consume('u:1', 'A.b', 5, 60)).resolves.toEqual({
      allowed: true,
      remaining: 4,
      resetSeconds: 60,
    });

    const gone = build(() => Promise.resolve([1, -2]));
    await expect(gone.service.consume('u:1', 'A.b', 5, 60)).resolves.toEqual({
      allowed: true,
      remaining: 4,
      resetSeconds: 60,
    });
  });

  it('7. 传给脚本的是窗口秒数的字符串形式（Lua 侧 ARGV 全是字符串）', async () => {
    const { service, args } = build(() => Promise.resolve([1, 60]));

    await service.consume('u:1', 'A.b', 5, 30);

    expect(args[0]).toHaveLength(3);
    expect(args[0][1]).toBe(1);
    expect(args[0][2]).toBe('30');
  });
});
