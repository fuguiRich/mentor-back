import type { ExecutionContext } from '@nestjs/common';
import { HttpStatus, Logger } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { ErrorCode } from '../../../common/constants/error-code';
import {
  currentActorId,
  currentPermissions,
  currentUser,
  requestContext,
} from '../../../common/context/request-context';
import type { SessionStore } from '../../../infra/redis/session-store.service';
import type { PermissionCacheService } from '../permission-cache.service';
import type { TokenService, VerifyResult } from '../token.service';
import { JwtAuthGuard } from './jwt-auth.guard';

function fakeContext(headers: Record<string, string>): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Probe {},
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

const authHeader = { authorization: 'Bearer stub-token' };

interface StubOptions {
  isPublic?: boolean;
  verified?: VerifyResult<{
    sub: string;
    username: string;
    sv: number;
    isSuperAdmin: boolean;
    jti: string;
    exp: number;
  }>;
  sessionVersion?: number | null;
  permissions?: readonly string[] | null;
  blacklisted?: boolean;
  loadResult?: string[];
}

function makeGuard(options: StubOptions = {}) {
  const verifyAccess = jest.fn().mockReturnValue(
    options.verified ?? {
      ok: true,
      payload: {
        sub: '42',
        username: 'alice',
        sv: 1,
        isSuperAdmin: false,
        jti: 'the-jti',
        exp: 1700000000,
      },
    },
  );
  const readGuardSnapshot = jest.fn().mockResolvedValue({
    // 不能用 `?? 1`：用例⑤要显式造 sessionVersion: null（缺键），?? 会把它吃成 1
    sessionVersion:
      options.sessionVersion === undefined ? 1 : options.sessionVersion,
    permissions:
      options.permissions === undefined ? ['a'] : options.permissions,
    blacklisted: options.blacklisted ?? false,
  });
  const load = jest.fn().mockResolvedValue(options.loadResult ?? ['b']);

  const guard = new JwtAuthGuard(
    {
      getAllAndOverride: jest.fn().mockReturnValue(options.isPublic ?? false),
    } as unknown as Reflector,
    { verifyAccess } as unknown as TokenService,
    { readGuardSnapshot } as unknown as SessionStore,
    { load } as unknown as PermissionCacheService,
  );

  return { guard, verifyAccess, readGuardSnapshot, load };
}

describe('JwtAuthGuard', () => {
  // 坏令牌/黑名单走 debug 级日志；测试里不出声，输出才是干净的
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('① @Public() 为真 → 直接 true，且不碰 token / Redis', async () => {
    const { guard, verifyAccess, readGuardSnapshot } = makeGuard({
      isPublic: true,
    });

    const result = await requestContext.run({ traceId: 't' }, () =>
      guard.canActivate(fakeContext({})),
    );

    expect(result).toBe(true);
    expect(verifyAccess).not.toHaveBeenCalled();
    expect(readGuardSnapshot).not.toHaveBeenCalled();
  });

  it('② 无 Authorization 头 → 401 / 10002', async () => {
    const { guard } = makeGuard();

    await expect(
      requestContext.run({ traceId: 't' }, () =>
        guard.canActivate(fakeContext({})),
      ),
    ).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
      response: { code: ErrorCode.UNAUTHORIZED, message: '缺少访问令牌' },
    });
  });

  it('③ verifyAccess 返回 invalid → 401', async () => {
    const { guard } = makeGuard({ verified: { ok: false, reason: 'invalid' } });

    await expect(
      requestContext.run({ traceId: 't' }, () =>
        guard.canActivate(fakeContext(authHeader)),
      ),
    ).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
      response: { code: ErrorCode.UNAUTHORIZED },
    });
  });

  it('④ 令牌已在黑名单 → 401', async () => {
    const { guard } = makeGuard({ blacklisted: true });

    await expect(
      requestContext.run({ traceId: 't' }, () =>
        guard.canActivate(fakeContext(authHeader)),
      ),
    ).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
      response: { code: ErrorCode.UNAUTHORIZED },
    });
  });

  it('⑤ sessionVersion 为 null → 401（Redis 被清也算失效）；正向对照：sv 对得上 → true', async () => {
    const missing = makeGuard({ sessionVersion: null });
    await expect(
      requestContext.run({ traceId: 't' }, () =>
        missing.guard.canActivate(fakeContext(authHeader)),
      ),
    ).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
      response: { code: ErrorCode.UNAUTHORIZED },
    });

    const ok = makeGuard({ sessionVersion: 1 });
    await expect(
      requestContext.run({ traceId: 't' }, () =>
        ok.guard.canActivate(fakeContext(authHeader)),
      ),
    ).resolves.toBe(true);
  });

  it('⑥ sv 不匹配（令牌 1、Redis 2）→ 401', async () => {
    const { guard } = makeGuard({ sessionVersion: 2 });

    await expect(
      requestContext.run({ traceId: 't' }, () =>
        guard.canActivate(fakeContext(authHeader)),
      ),
    ).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
      response: { code: ErrorCode.UNAUTHORIZED },
    });
  });

  it('⑦ 命中缓存：permissions 落进上下文，且不调 permissionCache.load', async () => {
    const { guard, load } = makeGuard({ permissions: ['a'] });

    await requestContext.run({ traceId: 't' }, async () => {
      await guard.canActivate(fakeContext(authHeader));
      expect(currentPermissions()).toEqual(['a']);
    });

    expect(load).not.toHaveBeenCalled();
  });

  it('⑧ 未命中缓存：permissions 为 null → 调 load，上下文权限取它的返回值', async () => {
    const { guard, load } = makeGuard({
      permissions: null,
      loadResult: ['b', 'c'],
    });

    await requestContext.run({ traceId: 't' }, async () => {
      await guard.canActivate(fakeContext(authHeader));
      expect(currentPermissions()).toEqual(['b', 'c']);
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(42n);
  });

  it('⑨ 身份真的写进了中间件建好的 store（R4）', async () => {
    const { guard } = makeGuard();

    await requestContext.run({ traceId: 't' }, async () => {
      await guard.canActivate(fakeContext(authHeader));

      expect(currentUser()).toMatchObject({
        userId: 42n,
        username: 'alice',
        isSuperAdmin: false,
        accessJti: 'the-jti',
        accessExpiresAt: 1700000000,
      });
      expect(currentActorId()).toBe(42n);
    });
  });
});
