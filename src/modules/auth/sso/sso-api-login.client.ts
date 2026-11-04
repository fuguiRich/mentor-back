import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { constants, createHmac, publicEncrypt, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Agent } from 'undici';
import type { AppConfig } from '../../../config/configuration';
import { classifySsoFailure, SsoApiError } from './sso-error';
import { SsoRateLimiter } from './sso-rate-limiter.service';

export interface SsoLoginUser {
  userName: string;
  nickName: string;
  userType: string;
  deptId: string | null;
  deptName: string | null;
  isDefaultPwd: boolean | null;
}

export interface SsoLoginResult {
  user: SsoLoginUser;
}

/**
 * `sign = HMAC-SHA256(`${clientId}:${username}:${timestamp}:${nonce}`, clientSecret)`。
 *
 * 抽成纯函数是为了单测能钉住拼接顺序与编码：顺序错了 SSO 只会回
 * 「签名校验失败」，看不出是哪一段错了。
 */
export function buildApiLoginSign(
  clientId: string,
  username: string,
  timestampMs: number,
  nonce: string,
  secret: string,
): string {
  return createHmac('sha256', secret)
    .update(`${clientId}:${username}:${timestampMs}:${nonce}`)
    .digest('hex');
}

interface PublicKeyCache {
  pem: string;
  fetchedAt: number;
}

const PUBLIC_KEY_TTL_MS = 60 * 60 * 1000;

/**
 * 学校统一认证 `POST /sso/login/api-login` 的客户端。
 *
 * 只负责「用户名 + 密码 → SSO user」，不建会话、不签发本系统令牌；那些是
 * `AuthService` 的事。所有失败都以 `SsoApiError` 抛出，调用方按 `kind` 决定
 * 能不能回退本地密码。
 */
@Injectable()
export class SsoApiLoginClient {
  private readonly logger = new Logger(SsoApiLoginClient.name);
  private publicKeyCache: PublicKeyCache | null = null;
  private dispatcher: Agent | null = null;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly rateLimiter: SsoRateLimiter,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async login(username: string, password: string): Promise<SsoLoginResult> {
    await this.rateLimiter.consume();

    const baseUrl = this.config.getOrThrow('sso.baseUrl', { infer: true });
    const apiLoginPath = this.config.getOrThrow('sso.apiLoginPath', {
      infer: true,
    });
    const appId = this.config.getOrThrow('sso.appId', { infer: true });
    const appSecret = this.config.getOrThrow('sso.appSecret', { infer: true });
    const mode = this.config.getOrThrow('sso.appSecretMode', { infer: true });
    const timeoutMs = this.config.getOrThrow('sso.apiLoginTimeoutMs', {
      infer: true,
    });

    const timestamp = Date.now();
    const nonce = randomBytes(8).toString('hex');
    const sign = buildApiLoginSign(
      appId,
      username,
      timestamp,
      nonce,
      appSecret,
    );

    const body: Record<string, unknown> = {
      username,
      password,
      clientId: appId,
      timestamp,
      nonce,
      sign,
    };
    if (mode === 'plain') {
      body.appKey = appSecret;
    } else {
      body.appSecret = await this.encryptSecret(appSecret, baseUrl);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}${apiLoginPath}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        // 不跟随重定向：307/308 会把含明文密码的 body 重发到别处，
        // 302 到 HTML 页又会被误判成 invalid/unavailable。
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        ...(this.getDispatcher() === null
          ? {}
          : { dispatcher: this.getDispatcher() }),
      });
    } catch (error: unknown) {
      // 只有这一条分支允许回退本地密码：网络层根本没到达 SSO。
      throw new SsoApiError(
        'unavailable',
        error instanceof Error ? error.message : String(error),
        null,
        null,
        error instanceof Error ? error.message : String(error),
      );
    }

    if (response.status >= 300 && response.status < 400) {
      throw new SsoApiError(
        'invalid',
        'SSO 登录地址返回了重定向',
        response.status,
      );
    }

    const parsed = await this.readJson(response);
    const code = readCode(parsed);
    const ssoMsg = readMsg(parsed);

    if (!response.ok || code !== 200) {
      const kind = classifySsoFailure({
        httpStatus: response.status,
        body: parsed,
      });
      throw new SsoApiError(
        kind,
        ssoMsg ?? `统一认证返回 ${response.status}`,
        response.status,
        code,
        ssoMsg,
      );
    }

    const user = readUser(parsed);
    if (user === null) {
      throw new SsoApiError(
        'invalid',
        '统一认证响应里没有可用的用户信息',
        response.status,
        code,
        ssoMsg,
      );
    }

    return { user };
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // 5xx 常见是网关的 HTML 错误页：仍按「上游不可用」归类，
      // 不能因为解析失败就把 5xx 降级成 invalid 而丢掉回退判断。
      const kind = response.status >= 500 ? 'unavailable' : 'invalid';
      throw new SsoApiError(kind, '统一认证返回的不是 JSON', response.status);
    }
  }

  private async encryptSecret(
    secret: string,
    baseUrl: string,
  ): Promise<string> {
    const pem = await this.getPublicKey(baseUrl);
    try {
      const encrypted = publicEncrypt(
        {
          key: pem,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
        },
        Buffer.from(secret, 'utf8'),
      );
      return encrypted.toString('base64');
    } catch (error: unknown) {
      throw new SsoApiError(
        'config',
        `SSO 公钥加密失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async getPublicKey(baseUrl: string): Promise<string> {
    const now = Date.now();
    if (
      this.publicKeyCache !== null &&
      now - this.publicKeyCache.fetchedAt < PUBLIC_KEY_TTL_MS
    ) {
      return this.publicKeyCache.pem;
    }

    const path = this.config.getOrThrow('sso.publicKeyPath', { infer: true });
    const timeoutMs = this.config.getOrThrow('sso.apiLoginTimeoutMs', {
      infer: true,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}${path}`, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        ...(this.getDispatcher() === null
          ? {}
          : { dispatcher: this.getDispatcher() }),
      });
    } catch (error: unknown) {
      // 公钥拿不到也是「网络层不可达」，必须让登录链路走本地回退，
      // 不能归类成 config（那会直接 20109、不给用户任何登录路径）。
      throw new SsoApiError(
        'unavailable',
        `获取 SSO 公钥失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (response.status >= 300 && response.status < 400) {
      throw new SsoApiError('invalid', 'SSO 公钥地址返回了重定向');
    }

    const parsed = await this.readJson(response);
    const pem = readPublicKey(parsed);
    if (!response.ok || pem === null) {
      throw new SsoApiError('config', 'SSO 公钥响应无效');
    }

    this.publicKeyCache = { pem, fetchedAt: now };
    return pem;
  }

  /** 私有 CA 才需要；返回 null 表示用系统信任链 */
  private getDispatcher(): Agent | null {
    if (this.dispatcher !== null) {
      return this.dispatcher;
    }
    const caCertPath = this.config.getOrThrow('sso.caCertPath', {
      infer: true,
    });
    if (caCertPath === '') {
      return null;
    }
    try {
      this.dispatcher = new Agent({
        connect: { ca: readFileSync(caCertPath, 'utf8') },
      });
    } catch (error: unknown) {
      throw new SsoApiError(
        'config',
        `读取 SSO CA 证书失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.logger.log(`SSO 使用自定义 CA：${caCertPath}`);
    return this.dispatcher;
  }
}

function readCode(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const code = (body as { code?: unknown }).code;
  return typeof code === 'number' ? code : null;
}

function readMsg(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const msg = (body as { msg?: unknown }).msg;
  return typeof msg === 'string' && msg.trim() !== '' ? msg.trim() : null;
}

function readPublicKey(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const pem = (body as { publicKey?: unknown }).publicKey;
  return typeof pem === 'string' && pem.trim() !== '' ? pem : null;
}

function readUser(body: unknown): SsoLoginUser | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const raw = (body as { user?: unknown }).user;
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const user = raw as Record<string, unknown>;
  const userName = user.userName;
  if (typeof userName !== 'string' || userName.trim() === '') {
    return null;
  }

  const dept =
    typeof user.dept === 'object' && user.dept !== null
      ? (user.dept as Record<string, unknown>)
      : null;

  return {
    userName: userName.trim(),
    nickName: typeof user.nickName === 'string' ? user.nickName : '',
    userType: typeof user.userType === 'string' ? user.userType : '',
    deptId: readString(dept?.deptId),
    deptName: readString(dept?.deptName),
    isDefaultPwd:
      typeof user.isDefaultPwd === 'boolean' ? user.isDefaultPwd : null,
  };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
