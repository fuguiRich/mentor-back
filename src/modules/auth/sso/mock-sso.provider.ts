import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../../config/configuration';
import type { SsoProvider } from './sso.provider';

/**
 * 本地联调用的假统一认证：**回调里的 ticket 就是工号**，不做任何真实认证。
 *
 * R12：它在 NODE_ENV=production 下启用会让启动直接失败（校验在 env.validation.ts）。
 * 这里不再兜一遍——配置错误应在启动时暴露一次，不在每个请求上重复报警。
 */
@Injectable()
export class MockSsoProvider implements SsoProvider {
  readonly name = 'mock';
  private readonly logger = new Logger(MockSsoProvider.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  buildAuthorizeUrl(state: string): string {
    const redirectUri = this.config.get('sso.redirectUri', { infer: true });
    const base = redirectUri === '' ? '/auth/sso/callback' : redirectUri;

    // 「认证页」就是回调地址本身，工号留一个占位符由联调者自己替换。
    // 这样 authorize 接口也能被 e2e 断言（URL 里带 state），不必真去跳一次。
    return `${base}?state=${encodeURIComponent(state)}&ticket=${encodeURIComponent('{employeeNo}')}`;
  }

  exchangeTicket(ticket: string): Promise<string | null> {
    const employeeNo = ticket.trim();
    if (employeeNo === '') {
      this.logger.warn('mock SSO 收到空票据');
      return Promise.resolve(null);
    }

    this.logger.log(`mock SSO 直接把票据当工号：${employeeNo}`);
    return Promise.resolve(employeeNo);
  }
}
