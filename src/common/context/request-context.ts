import { AsyncLocalStorage } from 'node:async_hooks';
import type { DataScopeCeiling } from '../constants/data-scope';

/** 无请求上下文时写入的审计操作者标识（规范 DB-04） */
export const SYSTEM_USER_ID = 0n;

export interface RequestContext {
  traceId: string;
  /** 以下六项在守卫通过后写入（JwtAuthGuard → setAuthenticatedUser） */
  userId?: bigint;
  username?: string;
  isSuperAdmin?: boolean;
  permissions?: readonly string[];
  /** 本次请求所持 access 令牌的标识与过期时刻（epoch 秒），登出要用 */
  accessJti?: string;
  accessExpiresAt?: number;
  /**
   * `@DataScope` 声明的接口上限（DataScopeInterceptor 写入）。
   * 取不到时 {@link currentDataScopeCeiling} 回落 `'self'`（fail-closed）。
   */
  dataScopeCeiling?: DataScopeCeiling;
}

/**
 * 当前登录者。守卫放行后必定存在；`@Public()` 路由上调用 `@CurrentUser()` 会拿到 undefined。
 *
 * `accessJti` / `accessExpiresAt` 是**凭证**不是用户属性，但只有守卫验过令牌之后
 * 才拿得到，而登出要把 jti 写进黑名单、TTL 取剩余寿命（`POST /auth/logout`）。
 * 放进同一个结构而不是让登出自己再验一次令牌：验签做两遍没有收益，
 * 且第二遍的结果与第一遍不一致时（例如刚被踢下线）会分叉出两种登出行为。
 */
export interface RequestUser {
  userId: bigint;
  username: string;
  isSuperAdmin: boolean;
  accessJti: string;
  accessExpiresAt: number;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * 把通过鉴权的身份写进**中间件已建好的**上下文对象（R4）。
 *
 * 刻意用「取出来、就地改」，而不是在这里 `requestContext.run(...)`：
 * `configureApp` 的中间件已经 `run()` 过（bootstrap.ts:50-52），`next()` 在 run 内
 * 同步调用，整条请求链共享同一个 store。守卫里再 `run()` 一次**覆盖不到 handler**
 * ——`canActivate` 返回之后，handler 在另一个异步上下文里执行，读到的还是中间件那个。
 * 后果是静默的：`currentActorId()` 恒为 0，审计字段记不下真实操作者，测试也不会红。
 * 之所以敢断言「跑不到 handler」，是因为这正是批次一 e2e 里 created_by 断言的反面
 * ——Task 2 Step 11 用「登录后创建部门 ⇒ createdBy === 当前用户 ID」把它钉死。
 */
export function setAuthenticatedUser(
  user: RequestUser,
  permissions: readonly string[],
): void {
  const store = requestContext.getStore();
  if (store === undefined) {
    throw new Error(
      '请求上下文不存在：setAuthenticatedUser 必须在 configureApp 的中间件之后调用',
    );
  }

  store.userId = user.userId;
  store.username = user.username;
  store.isSuperAdmin = user.isSuperAdmin;
  store.permissions = permissions;
  store.accessJti = user.accessJti;
  store.accessExpiresAt = user.accessExpiresAt;
}

export function currentUser(): RequestUser | undefined {
  const store = requestContext.getStore();
  if (
    store?.userId === undefined ||
    store.username === undefined ||
    store.isSuperAdmin === undefined ||
    store.accessJti === undefined ||
    store.accessExpiresAt === undefined
  ) {
    return undefined;
  }

  return {
    userId: store.userId,
    username: store.username,
    isSuperAdmin: store.isSuperAdmin,
    accessJti: store.accessJti,
    accessExpiresAt: store.accessExpiresAt,
  };
}

/** 当前请求者的权限码集合；未登录（`@Public()`）时为空集 */
export function currentPermissions(): readonly string[] {
  return requestContext.getStore()?.permissions ?? [];
}

export function currentActorId(): bigint {
  return requestContext.getStore()?.userId ?? SYSTEM_USER_ID;
}

export function currentTraceId(): string | undefined {
  return requestContext.getStore()?.traceId;
}

/**
 * 本次请求的数据范围上限（`@DataScope` 声明、DataScopeInterceptor 写入）。
 *
 * 取不到时回落 `'self'`（fail-closed）。**不是** `'all'`——上下文缺失时
 * 往宽取等于「一次异常把全校数据交出去」，往紧取最坏只是「少看了几行」。
 */
export function currentDataScopeCeiling(): DataScopeCeiling {
  return requestContext.getStore()?.dataScopeCeiling ?? 'self';
}
