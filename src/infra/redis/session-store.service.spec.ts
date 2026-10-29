import type { ConfigService } from '@nestjs/config';
import {
  PERMISSIONS_CACHE_TTL_SECONDS,
  SESSION_VERSION_TTL_SECONDS,
} from '../../common/constants/auth.constants';
import type { RedisService } from './redis.service';
import {
  parseSessionVersion,
  parsePermissions,
  SessionStore,
} from './session-store.service';

function configStub(refreshTtlSeconds = 604800): ConfigService {
  return {
    getOrThrow: (key: string) => {
      if (key === 'jwt.refreshTtlSeconds') {
        return refreshTtlSeconds;
      }
      throw new Error(`未预期的配置键：${key}`);
    },
  } as unknown as ConfigService;
}

/** 假 Redis：可读写的 Map + 记录 set 的参数（用来钉 TTL 与写入值） */
function fakeRedis() {
  const kv = new Map<string, string>();
  const setCalls: Array<{
    key: string;
    value: string;
    ttl: number;
    nx: boolean;
  }> = [];

  const client = {
    get: (key: string): Promise<string | null> =>
      Promise.resolve(kv.get(key) ?? null),
    set: (
      key: string,
      value: string,
      ...flags: Array<string | number>
    ): Promise<'OK' | null> => {
      const nx = flags.includes('NX');
      const exIndex = flags.indexOf('EX');
      const ttl = exIndex >= 0 ? Number(flags[exIndex + 1]) : 0;
      setCalls.push({ key, value, ttl, nx });
      if (nx && kv.has(key)) {
        return Promise.resolve(null);
      }
      kv.set(key, value);
      return Promise.resolve('OK');
    },
    del: (...keys: string[]): Promise<number> => {
      let removed = 0;
      for (const key of keys) {
        if (kv.delete(key)) {
          removed += 1;
        }
      }
      return Promise.resolve(removed);
    },
    incr: (key: string): Promise<number> => {
      const next = Number(kv.get(key) ?? '0') + 1;
      kv.set(key, String(next));
      return Promise.resolve(next);
    },
    expire: (): Promise<number> => Promise.resolve(1),
  };

  return { kv, setCalls, redis: { client } as unknown as RedisService };
}

describe('parseSessionVersion', () => {
  it.each([
    ['3', 3],
    [null, null],
    ['abc', null],
    ['1.5', null],
  ])('parseSessionVersion(%p) → %p', (raw, expected) => {
    // 非数字一律当"没有这个键"，让调用方走失效分支
    expect(parseSessionVersion(raw)).toBe(expected);
  });
});

describe('parsePermissions', () => {
  // 这几条是「缓存坏掉不能让请求变 500、也不能变成空权限」的机制：
  // 损坏 → 未命中（回源重算）；绝不能当成空集（那等于"缓存坏了 = 所有人没权限"）。
  it('JSON 字符串数组 → 原样返回', () => {
    expect(parsePermissions('["a","b"]')).toEqual(['a', 'b']);
  });

  it('JSON 对象不是数组 → null（未命中）', () => {
    expect(parsePermissions('{"a":1}')).toBeNull();
  });

  it('非字符串元素被过滤掉，不抛', () => {
    expect(parsePermissions('[1,"a"]')).toEqual(['a']);
  });

  it('数组里全是非字符串 → null（未命中），不能当成空权限集', () => {
    expect(parsePermissions('[1,2]')).toBeNull();
  });

  it('损坏的 JSON → null（未命中）', () => {
    expect(parsePermissions('not json')).toBeNull();
  });

  it('null → null（未命中）', () => {
    expect(parsePermissions(null)).toBeNull();
  });

  it('空数组是合法的"零权限"缓存值', () => {
    expect(parsePermissions('[]')).toEqual([]);
  });
});

describe('SessionStore.execPipeline 失败分支', () => {
  it('exec() 返回 [[Error, null]] 时抛出该错误，而不是把 null 当成"读到的值"', async () => {
    interface FakePipeline {
      get(key: string): FakePipeline;
      exists(key: string): FakePipeline;
      exec(): Promise<Array<[Error | null, unknown]>>;
    }

    const fakePipeline: FakePipeline = {
      get(this: FakePipeline) {
        return this;
      },
      exists(this: FakePipeline) {
        return this;
      },
      exec: () => Promise.resolve([[new Error('boom'), null]]),
    };
    const fakeRedisService = {
      client: { pipeline: () => fakePipeline },
    } as unknown as RedisService;

    const store = new SessionStore(fakeRedisService, configStub());

    await expect(store.readGuardSnapshot(1n, 'jti')).rejects.toThrow('boom');
  });
});

describe('SessionStore 会话版本（吊销状态，不是缓存）', () => {
  it('sv 键的 TTL 是会话 TTL，不是权限缓存 TTL', async () => {
    const { setCalls, redis } = fakeRedis();
    const store = new SessionStore(
      redis,
      configStub(SESSION_VERSION_TTL_SECONDS),
    );

    await store.ensureSessionVersion(42n);

    expect(setCalls[0].ttl).toBe(SESSION_VERSION_TTL_SECONDS);
    expect(setCalls[0].ttl).not.toBe(PERMISSIONS_CACHE_TTL_SECONDS);
  });

  it('配置的 refresh 寿命更长时，sv TTL 取更长的那个', async () => {
    const longTtl = 8 * 24 * 60 * 60;
    const { setCalls, redis } = fakeRedis();
    const store = new SessionStore(redis, configStub(longTtl));

    await store.ensureSessionVersion(42n);

    expect(setCalls[0].ttl).toBe(longTtl);
  });

  it('ensureSessionVersion 缺键时不返回 1、也不写 "1"（否则 sv=1 的旧令牌复活）', async () => {
    const { kv, redis } = fakeRedis();
    const store = new SessionStore(redis, configStub());

    const version = await store.ensureSessionVersion(42n);

    expect(version).not.toBe(1);
    expect(kv.get('auth:sv:42')).not.toBe('1');
    expect(kv.get('auth:sv:42')).toBe(String(version));
  });

  it('ensureSessionVersion 二次调用读到已存在的种子，而不是覆盖它', async () => {
    const { kv, redis } = fakeRedis();
    const store = new SessionStore(redis, configStub());

    const first = await store.ensureSessionVersion(42n);
    const second = await store.ensureSessionVersion(42n);

    expect(second).toBe(first);
    expect(kv.get('auth:sv:42')).toBe(String(first));
  });

  it('revokeSessions 缺键时写出的版本号不是任何第一代令牌能携带的值（≠ 1）', async () => {
    const { kv, redis } = fakeRedis();
    const store = new SessionStore(redis, configStub());

    await store.revokeSessions(42n);

    const written = kv.get('auth:sv:42');
    expect(written).not.toBe('1');
    expect(Number(written)).toBeGreaterThan(1);
  });

  it('revokeSessions 已有键时写出严格更大的版本号', async () => {
    const { kv, redis } = fakeRedis();
    const store = new SessionStore(redis, configStub());

    await store.ensureSessionVersion(42n);
    const before = Number(kv.get('auth:sv:42'));
    await store.revokeSessions(42n);
    const after = Number(kv.get('auth:sv:42'));

    expect(after).toBeGreaterThan(before);
  });
});
