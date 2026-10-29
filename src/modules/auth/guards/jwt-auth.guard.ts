import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ErrorCode } from '../../../common/constants/error-code';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { setAuthenticatedUser } from '../../../common/context/request-context';
import { BusinessException } from '../../../common/errors/business.exception';
import { PermissionCacheService } from '../permission-cache.service';
import { SessionStore } from '../../../infra/redis/session-store.service';
import { TokenService } from '../token.service';
import { extractBearerToken } from './bearer-token.util';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly sessions: SessionStore,
    private readonly permissionCache: PermissionCacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic =
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true;
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token = extractBearerToken(request.headers.authorization);
    if (token === null) {
      throw this.reject('缺少访问令牌');
    }

    const verified = this.tokens.verifyAccess(token);
    if (!verified.ok) {
      // debug 级别：坏令牌可能是扫描器打进来的，记 warn 会把正常日志淹掉
      this.logger.debug(`access 令牌校验失败（${verified.reason}）`);
      throw this.reject('登录状态已失效，请重新登录');
    }

    const { sub, username, sv, isSuperAdmin, jti, exp } = verified.payload;
    const userId = this.toUserId(sub);

    // 一次 pipeline 取齐：会话版本、权限码、黑名单
    const snapshot = await this.sessions.readGuardSnapshot(userId, jti);
    if (snapshot.blacklisted) {
      this.logger.debug(`access 令牌已在黑名单中（jti=${jti}）`);
      throw this.reject('登录状态已失效，请重新登录');
    }

    if (snapshot.sessionVersion === null || snapshot.sessionVersion !== sv) {
      // sv 键丢失（Redis 被清）也走这里：**失效方向要偏安全**，
      // 让用户重新登录，而不是放行一枚版本号对不上的令牌。
      throw this.reject('登录状态已失效，请重新登录');
    }

    const permissions =
      snapshot.permissions ?? (await this.permissionCache.load(userId));

    // R4：就地把身份写进中间件建好的上下文，不另起 run()
    setAuthenticatedUser(
      { userId, username, isSuperAdmin, accessJti: jti, accessExpiresAt: exp },
      permissions,
    );
    return true;
  }

  private toUserId(sub: string): bigint {
    try {
      return BigInt(sub);
    } catch {
      throw this.reject('登录状态已失效，请重新登录');
    }
  }

  private reject(message: string): BusinessException {
    return new BusinessException(
      ErrorCode.UNAUTHORIZED,
      message,
      HttpStatus.UNAUTHORIZED,
    );
  }
}
