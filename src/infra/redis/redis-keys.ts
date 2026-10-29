/**
 * 本系统在 Redis 里用到的键名，**只此一处**。
 *
 * 存在的理由是一个具体的失败模式：`role` 模块要清用户的权限缓存、`user` 模块要让
 * 某人的令牌立即失效，而键名是 auth 的领域知识。若两边各写一份字符串，改名的瞬间
 * 就分成两个命名空间——清缓存的那一半静默失效，没有任何东西会报错。
 */
const AUTH_PREFIX = 'auth';
const RATE_LIMIT_PREFIX = 'rl';

export const redisKeys = {
  /** 前缀，供 e2e 清库（只删本系统写的键，不用 FLUSHDB 打别人） */
  authPrefix: `${AUTH_PREFIX}:`,
  rateLimitPrefix: `${RATE_LIMIT_PREFIX}:`,

  auth: {
    /**
     * 会话版本：改密码 / 停用 / 踢人时置为 `max(Date.now(), 当前值 + 1)`
     * （**不是 `INCR`**，见 session-store.service 的 revokeSessions），该用户
     * 全部已签发令牌同时失效。
     */
    sessionVersion: (userId: bigint | string): string =>
      `${AUTH_PREFIX}:sv:${userId.toString()}`,

    /** 权限码缓存（JSON 数组），cache-aside */
    permissions: (userId: bigint | string): string =>
      `${AUTH_PREFIX}:perms:${userId.toString()}`,

    /** refresh 令牌白名单；值 = 持有者 userId，logout 时用它校验归属 */
    refreshToken: (jti: string): string => `${AUTH_PREFIX}:rt:${jti}`,

    /** access 令牌黑名单（登出） */
    accessBlacklist: (jti: string): string => `${AUTH_PREFIX}:bl:${jti}`,

    /** 登录失败计数，按用户名 */
    loginFailures: (username: string): string =>
      `${AUTH_PREFIX}:fail:${username}`,

    /** SSO state（防 CSRF），一次性消费 */
    ssoState: (state: string): string => `${AUTH_PREFIX}:sso:${state}`,
  },

  rateLimit: {
    /**
     * 固定窗口计数器。`identity` 是用户标识或来源 IP，`endpoint` 是
     * `类名.方法名`——两者一起才构成一个额度桶：按 URL 拼会让 `/users/1`
     * 与 `/users/2` 各占一桶（等于没有限流），按方法名才对应「这一个接口」。
     */
    window: (identity: string, endpoint: string): string =>
      `${RATE_LIMIT_PREFIX}:${identity}:${endpoint}`,
  },
} as const;
