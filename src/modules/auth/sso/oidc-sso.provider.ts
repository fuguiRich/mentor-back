import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../../config/configuration';
import type { SsoProvider } from './sso.provider';

/**
 * 可配置的通用 OIDC provider（授权码模式）。
 *
 * 走的是标准三步：authorize URL → 回调带 code → code 换 token → token 取 userinfo。
 * 学校文档到位后，若协议不是 OIDC（比如 CAS），换掉本文件即可——
 * AuthService 只认 SsoProvider 接口（spec 第 7 节「换实现不动调用方」）。
 *
 * 所有失败都返回 null 不抛：对调用者「票据无效」「断网」「少了声明」没有区分价值，
 * 统一回 20106，细节记在这里的日志里。**不要**把上游响应体回显给调用者——
 * 那会把 provider 的实现细节与可能含密钥的字段带出边界。
 */
@Injectable()
export class OidcSsoProvider implements SsoProvider {
  readonly name = 'oidc';
  private readonly logger = new Logger(OidcSsoProvider.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  buildAuthorizeUrl(state: string): string {
    const url = new URL(this.config.get('sso.authorizeUrl', { infer: true }));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid');
    url.searchParams.set(
      'client_id',
      this.config.get('sso.clientId', { infer: true }),
    );
    url.searchParams.set(
      'redirect_uri',
      this.config.get('sso.redirectUri', { infer: true }),
    );
    url.searchParams.set('state', state);

    return url.toString();
  }

  async exchangeTicket(ticket: string): Promise<string | null> {
    try {
      const accessToken = await this.exchangeCodeForToken(ticket);
      if (accessToken === null) {
        return null;
      }
      return await this.readEmployeeNo(accessToken);
    } catch (error) {
      this.logger.warn(
        `OIDC 票据换取失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async exchangeCodeForToken(code: string): Promise<string | null> {
    const tokenUrl = this.config.get('sso.tokenUrl', { infer: true });
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.get('sso.redirectUri', { infer: true }),
      client_id: this.config.get('sso.clientId', { infer: true }),
      client_secret: this.config.get('sso.clientSecret', { infer: true }),
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      this.logger.warn(`OIDC token 端点返回 ${response.status}`);
      return null;
    }

    const payload: unknown = await response.json();
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('access_token' in payload) ||
      typeof (payload as { access_token?: unknown }).access_token !== 'string'
    ) {
      this.logger.warn('OIDC token 响应里没有 access_token');
      return null;
    }

    return (payload as { access_token: string }).access_token;
  }

  private async readEmployeeNo(accessToken: string): Promise<string | null> {
    const userinfoUrl = this.config.get('sso.userinfoUrl', { infer: true });
    const claim = this.config.get('sso.employeeNoClaim', { infer: true });

    const response = await fetch(userinfoUrl, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
      },
    });

    if (!response.ok) {
      this.logger.warn(`OIDC userinfo 端点返回 ${response.status}`);
      return null;
    }

    const payload: unknown = await response.json();
    if (typeof payload !== 'object' || payload === null) {
      return null;
    }

    const value = (payload as Record<string, unknown>)[claim];
    if (typeof value !== 'string' || value.trim() === '') {
      this.logger.warn(`OIDC userinfo 里没有可用的 ${claim} 声明`);
      return null;
    }

    return value.trim();
  }
}
