import { HealthRepository } from './health.repository';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';

function buildRepository(probes: {
  queryRaw?: () => Promise<unknown>;
  ping?: () => Promise<unknown>;
}): HealthRepository {
  const prisma = {
    client: {
      $queryRaw: probes.queryRaw ?? (() => Promise.resolve([])),
    },
  } as unknown as PrismaService;
  const redis = {
    client: {
      ping: probes.ping ?? (() => Promise.resolve('PONG')),
    },
  } as unknown as RedisService;

  return new HealthRepository(prisma, redis);
}

describe('HealthRepository 探针契约', () => {
  // 不变量：依赖失败不是异常，而是要报告的事实——probe 必须 resolve 出 down，
  // 而不是把异常抛给 HealthService（那会让 /health 在依赖挂掉时变成 500，
  // 而 500 恰恰说明不了是哪个依赖挂了）。下面每个失败用例都用 resolves 断言，
  // probe 若改为抛出，这些用例会直接红。

  it('① $queryRaw 拒绝 → probeDatabase 仍 resolve 为 down + 错误信息', async () => {
    const repository = buildRepository({
      queryRaw: () => Promise.reject(new Error('connect ECONNREFUSED')),
    });

    await expect(repository.probeDatabase()).resolves.toEqual({
      status: 'down',
      message: 'connect ECONNREFUSED',
    });
  });

  it('② ping 拒绝 → probeRedis 仍 resolve 为 down + 错误信息', async () => {
    const repository = buildRepository({
      ping: () => Promise.reject(new Error('ERR max retries')),
    });

    await expect(repository.probeRedis()).resolves.toEqual({
      status: 'down',
      message: 'ERR max retries',
    });
  });

  it('③ 数据库连通 → probeDatabase 返回 up（失败用例的阳性对照）', async () => {
    const repository = buildRepository({});

    await expect(repository.probeDatabase()).resolves.toEqual({
      status: 'up',
    });
  });

  it('④ Redis 连通 → probeRedis 返回 up（阳性对照）', async () => {
    const repository = buildRepository({});

    await expect(repository.probeRedis()).resolves.toEqual({ status: 'up' });
  });

  it('⑤ 非 Error 拒绝（字符串）→ 走 String(error) 分支而不是读 .message', async () => {
    const repository = buildRepository({
      // 本用例要钉的正是「拒绝值不是 Error」这个半分支，必须真的用一个非 Error 值；
      // 把字符串包成 Error 就测不到 String(error) 那条路了。
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      queryRaw: () => Promise.reject('boom'),
    });

    await expect(repository.probeDatabase()).resolves.toEqual({
      status: 'down',
      message: 'boom',
    });
  });
});
