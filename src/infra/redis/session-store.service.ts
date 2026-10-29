import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChainableCommander } from 'ioredis';
import {
  LOGIN_LOCK_SECONDS,
  PERMISSIONS_CACHE_TTL_SECONDS,
  SESSION_VERSION_TTL_SECONDS,
} from '../../common/constants/auth.constants';
import { redisKeys } from './redis-keys';
import { RedisService } from './redis.service';

/** 守卫一次 pipeline 要读的全部东西 */
export interface GuardSnapshot {
  sessionVersion: number | null;
  permissions: readonly string[] | null;
  blacklisted: boolean;
}

/** Redis 里存的版本号解析：非数字一律当"没有这个键"，让调用方走失效分支 */
export function parseSessionVersion(raw: unknown): number | null {
  // null/undefined 必须先挡掉：Number(null) 是 0 而不是 NaN，不挡的话
  // "键不存在"会被读成版本号 0——ensureSessionVersion 会以为已初始化而永远不写键，
  // getLoginFailures 的 ?? 0 也成了死代码。语义以注释与单测为准（缺键 → null）。
  if (raw === null || raw === undefined) {
    return null;
  }

  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

/**
 * 权限码缓存解析。**损坏的缓存当作未命中**（返回 null，由调用方回源重算），
 * 而不是抛错：缓存是加速用的，它坏掉不该让用户的请求变成 500；
 * 也不能当作空集——那会变成"缓存坏了 = 所有人没权限"，是同一个错误的另一种写法。
 */
export function parsePermissions(raw: unknown): readonly string[] | null {
  if (typeof raw !== 'string') {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }

    const strings = parsed.filter(
      (item): item is string => typeof item === 'string',
    );
    // 元素全是非字符串（如 '[1,2]'）也是损坏：过滤后变 []，守卫会读成
    // "该用户零权限"，与"当作未命中、回源重算"的语义相反。
    if (parsed.length > 0 && strings.length === 0) {
      return null;
    }

    return strings;
  } catch {
    return null;
  }
}

@Injectable()
export class SessionStore {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  /**
   * sv 键的 TTL。sv 是吊销状态不是缓存，必须 ≥ refresh 寿命——refresh 载荷里
   * 带 sv，refreshTtlSeconds 之内随时可能来换新令牌（R22）。
   */
  private get sessionTtlSeconds(): number {
    return Math.max(
      SESSION_VERSION_TTL_SECONDS,
      this.config.getOrThrow<number>('jwt.refreshTtlSeconds'),
    );
  }

  private async execPipeline(pipeline: ChainableCommander): Promise<unknown[]> {
    const results = await pipeline.exec();
    if (results === null) {
      // pipeline 被事务丢弃（WATCH 冲突）时 exec 返回 null。本类不使用 WATCH，
      // 走到这里说明前提变了——大声报错，别当成"读到了空值"。
      throw new Error('Redis pipeline 未返回结果');
    }

    return results.map(([error, result]) => {
      if (error !== null) {
        throw error;
      }

      return result;
    });
  }

  /** 登录时确保存在：不存在则播种单调递增的种子，存在则原样返回（版本号必须跨登录稳定） */
  async ensureSessionVersion(userId: bigint): Promise<number> {
    const key = redisKeys.auth.sessionVersion(userId);
    const seed = Date.now();
    // ioredis 的类型重载只认 'EX', 秒, 'NX' 这个顺序（与 Redis 协议里 NX/EX 先后等价）
    const created = await this.redis.client.set(
      key,
      String(seed),
      'EX',
      this.sessionTtlSeconds,
      'NX',
    );
    if (created !== null) {
      return seed;
    }

    const current = parseSessionVersion(await this.redis.client.get(key));
    // 极小概率：SET NX 落败后键又没了（并发 revoke / 过期）。再试一次即可。
    return current ?? (await this.ensureSessionVersion(userId));
  }

  async getSessionVersion(userId: bigint): Promise<number | null> {
    return parseSessionVersion(
      await this.redis.client.get(redisKeys.auth.sessionVersion(userId)),
    );
  }

  /**
   * 续期 sv 键的 TTL（成功 refresh 时调用）。
   * 这一行 EXPIRE 就是「会话跨刷新存活」的机制；删掉它，会话会被钉在 7 天的硬天花板上。
   */
  async touchSessionVersion(userId: bigint): Promise<void> {
    await this.redis.client.expire(
      redisKeys.auth.sessionVersion(userId),
      this.sessionTtlSeconds,
    );
  }

  /** 守卫的唯一一次 Redis 往返：sv + perms + 黑名单 */
  async readGuardSnapshot(userId: bigint, jti: string): Promise<GuardSnapshot> {
    const [versionRaw, permissionsRaw, blacklistedRaw] =
      await this.execPipeline(
        this.redis.client
          .pipeline()
          .get(redisKeys.auth.sessionVersion(userId))
          .get(redisKeys.auth.permissions(userId))
          .exists(redisKeys.auth.accessBlacklist(jti)),
      );

    return {
      sessionVersion: parseSessionVersion(versionRaw),
      permissions: parsePermissions(permissionsRaw),
      blacklisted: Number(blacklistedRaw) === 1,
    };
  }

  /** 让某人的**全部**会话立即失效（R14）：重写会话版本、清权限缓存。 */
  async revokeSessions(userId: bigint): Promise<void> {
    const versionKey = redisKeys.auth.sessionVersion(userId);
    const current = parseSessionVersion(
      await this.redis.client.get(versionKey),
    );
    // 用 SET 而不是 INCR：INCR 在键不存在时会把它创建成 1，而"第一代"令牌的 sv
    // 恰好可能是 1——吊销动作反而把它们复活了。max(…, current+1) 保证新版本号
    // 严格大于此前任何签发过的值，且时钟回拨也不会往回走（R22）。
    const next = Math.max(Date.now(), (current ?? 0) + 1);
    await this.redis.client.set(
      versionKey,
      String(next),
      'EX',
      this.sessionTtlSeconds,
    );

    await this.redis.client.del(redisKeys.auth.permissions(userId));
    // 该用户的 refresh 键没有反向索引，不能 O(1) 删；靠 sv 变化失效即可。
  }

  async getPermissions(userId: bigint): Promise<readonly string[] | null> {
    return parsePermissions(
      await this.redis.client.get(redisKeys.auth.permissions(userId)),
    );
  }

  async setPermissions(
    userId: bigint,
    codes: readonly string[],
    ttlSeconds = PERMISSIONS_CACHE_TTL_SECONDS,
  ): Promise<void> {
    await this.redis.client.set(
      redisKeys.auth.permissions(userId),
      JSON.stringify(codes),
      'EX',
      ttlSeconds,
    );
  }

  /** 批量清缓存（角色改了权限 → 清持有该角色的所有用户）。空数组时不做无谓往返 */
  async clearPermissions(userIds: readonly bigint[]): Promise<void> {
    if (userIds.length === 0) {
      return;
    }

    await this.redis.client.del(
      ...userIds.map((userId) => redisKeys.auth.permissions(userId)),
    );
  }

  async storeRefreshToken(
    userId: bigint,
    jti: string,
    ttlSeconds: number,
  ): Promise<void> {
    await this.redis.client.set(
      redisKeys.auth.refreshToken(jti),
      userId.toString(),
      'EX',
      ttlSeconds,
    );
  }

  /** 白名单里的持有者；用于登出时校验"这枚 refresh 是不是你的" */
  async getRefreshTokenOwner(jti: string): Promise<string | null> {
    return this.redis.client.get(redisKeys.auth.refreshToken(jti));
  }

  async removeRefreshToken(jti: string): Promise<void> {
    await this.redis.client.del(redisKeys.auth.refreshToken(jti));
  }

  async blacklistAccessToken(jti: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) {
      // 令牌本来就过期了，黑名单没有意义——`EX 0` 在 Redis 里直接报错，
      // 会把这个"其实什么都不用做"的分支变成 500。
      return;
    }

    await this.redis.client.set(
      redisKeys.auth.accessBlacklist(jti),
      '1',
      'EX',
      ttlSeconds,
    );
  }

  /** 记一次登录失败，返回窗口内的累计次数。窗口只在第一次失败时开（EXPIRE NX 语义） */
  async registerLoginFailure(username: string): Promise<number> {
    const key = redisKeys.auth.loginFailures(username);
    const count = await this.redis.client.incr(key);
    if (count === 1) {
      await this.redis.client.expire(key, LOGIN_LOCK_SECONDS);
    }

    return count;
  }

  async getLoginFailures(username: string): Promise<number> {
    return (
      parseSessionVersion(
        await this.redis.client.get(redisKeys.auth.loginFailures(username)),
      ) ?? 0
    );
  }

  async clearLoginFailures(username: string): Promise<void> {
    await this.redis.client.del(redisKeys.auth.loginFailures(username));
  }

  async saveSsoState(state: string, ttlSeconds: number): Promise<void> {
    await this.redis.client.set(
      redisKeys.auth.ssoState(state),
      '1',
      'EX',
      ttlSeconds,
    );
  }

  /** 一次性消费：state 用过即删（票据重放的第一道闸） */
  async consumeSsoState(state: string): Promise<boolean> {
    const key = redisKeys.auth.ssoState(state);
    const removed = await this.redis.client.del(key);
    return removed === 1;
  }
}
