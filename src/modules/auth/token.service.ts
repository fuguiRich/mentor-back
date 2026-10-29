import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';

/** 一枚刚签发的令牌：调用方需要 jti（写白名单/黑名单）与剩余寿命（黑名单 TTL） */
export interface IssuedToken {
  token: string;
  jti: string;
  expiresIn: number;
}

export interface AccessTokenPayload {
  sub: string;
  username: string;
  sv: number;
  isSuperAdmin: boolean;
  jti: string;
  exp: number;
}

/**
 * refresh 载荷带 `sv`（R3）：不带就等于「改密码 / 停用 / 踢人之后，旧 refresh 还能换出一枚
 * 合法 access」——会话版本机制被整条绕过，且不报任何错。
 */
export interface RefreshTokenPayload {
  sub: string;
  sv: number;
  type: 'refresh';
  jti: string;
  exp: number;
}

export type VerifyResult<T> =
  { ok: true; payload: T } | { ok: false; reason: 'expired' | 'invalid' };

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  private get accessTtlSeconds(): number {
    return this.config.getOrThrow<number>('jwt.accessTtlSeconds');
  }

  private get refreshTtlSeconds(): number {
    return this.config.getOrThrow<number>('jwt.refreshTtlSeconds');
  }

  async signAccess(input: {
    userId: bigint;
    username: string;
    sv: number;
    isSuperAdmin: boolean;
  }): Promise<IssuedToken> {
    const jti = randomUUID();
    const token = await this.jwt.signAsync(
      {
        sub: input.userId.toString(),
        username: input.username,
        sv: input.sv,
        isSuperAdmin: input.isSuperAdmin,
      },
      { jwtid: jti, expiresIn: this.accessTtlSeconds },
    );

    return { token, jti, expiresIn: this.accessTtlSeconds };
  }

  async signRefresh(input: {
    userId: bigint;
    sv: number;
  }): Promise<IssuedToken> {
    const jti = randomUUID();
    const token = await this.jwt.signAsync(
      { sub: input.userId.toString(), sv: input.sv, type: 'refresh' },
      { jwtid: jti, expiresIn: this.refreshTtlSeconds },
    );

    return { token, jti, expiresIn: this.refreshTtlSeconds };
  }

  /**
   * 验签。**不抛异常**，失败以 `{ ok: false, reason }` 返回：调用方（守卫）要做的
   * 是统一的 401，把"为什么失败"分流到日志；用异常做控制流会让每个调用点
   * 都要 catch 一次，漏一个就是 500。
   */
  verifyAccess(token: string): VerifyResult<AccessTokenPayload> {
    return this.verify<AccessTokenPayload>(
      token,
      (payload) =>
        payload.type === undefined &&
        typeof payload.sub === 'string' &&
        typeof payload.username === 'string' &&
        typeof payload.sv === 'number' &&
        typeof payload.isSuperAdmin === 'boolean' &&
        typeof payload.jti === 'string' &&
        typeof payload.exp === 'number',
    );
  }

  verifyRefresh(token: string): VerifyResult<RefreshTokenPayload> {
    return this.verify<RefreshTokenPayload>(
      token,
      (payload) =>
        payload.type === 'refresh' &&
        typeof payload.sub === 'string' &&
        typeof payload.sv === 'number' &&
        typeof payload.jti === 'string' &&
        typeof payload.exp === 'number',
    );
  }

  private verify<T>(
    token: string,
    matches: (payload: Record<string, unknown>) => boolean,
  ): VerifyResult<T> {
    try {
      // algorithms 钉死 HS256：不钉的话，"谁构造 JwtService 谁负责"——
      // 同一密钥签出的 HS512 令牌会被默认策略接受，算法降级的空间由此打开。
      const payload = this.jwt.verify<Record<string, unknown>>(token, {
        algorithms: ['HS256'],
      });
      if (!matches(payload)) {
        return { ok: false, reason: 'invalid' };
      }

      return { ok: true, payload: payload as T };
    } catch (error) {
      return {
        ok: false,
        reason:
          error instanceof Error && error.name === 'TokenExpiredError'
            ? 'expired'
            : 'invalid',
      };
    }
  }
}
