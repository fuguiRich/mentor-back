import type { ExecutionContext } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { ErrorCode } from '../../../common/constants/error-code';
import {
  requestContext,
  setAuthenticatedUser,
  type RequestUser,
} from '../../../common/context/request-context';
import { PermissionGuard } from './permission.guard';

function fakeContext(): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Probe {},
    switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
  } as unknown as ExecutionContext;
}

function makeGuard(required: string[] | undefined): PermissionGuard {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(required),
  } as unknown as Reflector;

  return new PermissionGuard(reflector);
}

/**
 * `canActivate` 是同步的，抛错也是同步抛；包一层 Promise 让断言统一走 `rejects`。
 * 不用 `async` 包——没有 await 的 async 函数会撞 require-await。
 */
function canActivateInContext(guard: PermissionGuard): Promise<boolean> {
  return requestContext.run({ traceId: 't' }, () =>
    Promise.resolve().then(() => guard.canActivate(fakeContext())),
  );
}

const alice: RequestUser = {
  userId: 42n,
  username: 'alice',
  isSuperAdmin: false,
  accessJti: 'the-jti',
  accessExpiresAt: 1700000000,
};

describe('PermissionGuard', () => {
  it('① 无装饰器 → true，且即使未登录也 true（登录只归 JwtAuthGuard 管）', () => {
    const guard = makeGuard(undefined);

    const result = requestContext.run({ traceId: 't' }, () =>
      guard.canActivate(fakeContext()),
    );

    expect(result).toBe(true);
  });

  it('② 有 @RequirePermission 且未登录（空上下文）→ 401，不是放行', async () => {
    const guard = makeGuard(['user:list']);

    await expect(canActivateInContext(guard)).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
      response: { code: ErrorCode.UNAUTHORIZED },
    });
  });

  it('③ 超管即使权限码不在集合里也放行', () => {
    const guard = makeGuard(['user:list']);

    const result = requestContext.run({ traceId: 't' }, () => {
      setAuthenticatedUser({ ...alice, isSuperAdmin: true }, []);
      return guard.canActivate(fakeContext());
    });

    expect(result).toBe(true);
  });

  it('④ 普通用户持有该码 → true', () => {
    const guard = makeGuard(['user:list']);

    const result = requestContext.run({ traceId: 't' }, () => {
      setAuthenticatedUser(alice, ['user:list']);
      return guard.canActivate(fakeContext());
    });

    expect(result).toBe(true);
  });

  it('⑤ 普通用户缺该码 → 403 / 10003，message 里含缺失的码', async () => {
    const guard = makeGuard(['user:list']);

    await expect(
      requestContext.run({ traceId: 't' }, () => {
        setAuthenticatedUser(alice, ['user:export']);
        return Promise.resolve().then(() => guard.canActivate(fakeContext()));
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.FORBIDDEN,
      response: {
        code: ErrorCode.FORBIDDEN,
        message: '无权限访问：缺少 user:list',
      },
    });
  });

  it('⑥ 要求两个码、只满足一个 → 403（「与」关系）', async () => {
    const guard = makeGuard(['user:list', 'user:export']);

    await expect(
      requestContext.run({ traceId: 't' }, () => {
        setAuthenticatedUser(alice, ['user:list']);
        return Promise.resolve().then(() => guard.canActivate(fakeContext()));
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.FORBIDDEN,
      response: {
        code: ErrorCode.FORBIDDEN,
        message: '无权限访问：缺少 user:export',
      },
    });
  });

  it('⑦ 码表为空（@RequirePermission() 零参数）→ true：只校验登录，不在这里拒绝', () => {
    const guard = makeGuard([]);

    const result = requestContext.run({ traceId: 't' }, () => {
      setAuthenticatedUser(alice, []);
      return guard.canActivate(fakeContext());
    });

    expect(result).toBe(true);
  });
});
