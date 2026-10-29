import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { AppConfig } from '../../config/configuration';
import { ErrorCode } from '../../common/constants/error-code';
import { currentActorId } from '../../common/context/request-context';
import { BusinessException } from '../../common/errors/business.exception';
import { RateLimitService } from './rate-limit.service';

/**
 * 全局限流。**注册在 JwtAuthGuard / PermissionGuard 之后**——限额按「人」算才准，
 * 而身份是 JwtAuthGuard 写进请求上下文的。代价是带无效令牌的 401 打不进限流，
 * 那条路本身只做一次签名校验，打不穿数据库，且另有登录失败锁定兜着。
 *
 * 不按 IP 兜底到所有人：高校出口 NAT 后面常常是几千个真实用户共用一个 IP，
 * 一视同仁的 IP 限流会让他们互相打死。
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly rateLimit: RateLimitService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const actorId = currentActorId();
    const identity =
      actorId > 0n ? `u:${actorId}` : `ip:${req.ip ?? 'unknown'}`;
    const endpoint = `${context.getClass().name}.${context.getHandler().name}`;

    const limit =
      this.config.get('rateLimit.defaultLimit', { infer: true }) ?? 300;
    const windowSeconds =
      this.config.get('rateLimit.defaultWindowSeconds', { infer: true }) ?? 60;

    const decision = await this.rateLimit.consume(
      identity,
      endpoint,
      limit,
      windowSeconds,
    );

    // 标准的三件套，让客户端自己算什么时候能重试，不必猜
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
    res.setHeader('X-RateLimit-Reset', String(decision.resetSeconds));

    if (!decision.allowed) {
      // 429 由 all-exceptions.filter 的 HTTP_STATUS_TO_ERROR_CODE 落到
      // ErrorCode.RATE_LIMITED（10005）——那个码此前一直空挂，这里才真正用上。
      throw new BusinessException(
        ErrorCode.RATE_LIMITED,
        '请求过于频繁，请稍后再试',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
