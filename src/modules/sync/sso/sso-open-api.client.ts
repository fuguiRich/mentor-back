import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Agent } from 'undici';
import type { AppConfig } from '../../../config/configuration';
import type {
  SsoClass,
  SsoEduCollege,
  SsoOrgDept,
  SsoPage,
  SsoStudent,
  SsoTeacher,
} from './sso-open-api.types';

/** 分页兜底：源端 totalPages 坏掉时不能无限翻 */
const MAX_PAGES = 1000;

export class SsoOpenApiError extends Error {
  readonly status: number | null;
  readonly msg: string | null;

  constructor(status: number | null, msg: string | null) {
    super(msg ?? `SSO 开放接口返回 ${status ?? '网络错误'}`);
    this.name = 'SsoOpenApiError';
    this.status = status;
    this.msg = msg;
  }
}

/**
 * `sign = MD5("appId={appId}&timestamp={timestamp}&key={appSecret}").toUpperCase()`。
 *
 * 顺序、大写、末尾无 `&` 都是 SSO 文档钉死的；错一项只会得到「签名无效」。
 */
export function buildOpenApiSign(
  appId: string,
  timestampSeconds: number,
  appSecret: string,
): string {
  return createHash('md5')
    .update(`appId=${appId}&timestamp=${timestampSeconds}&key=${appSecret}`)
    .digest('hex')
    .toUpperCase();
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

/**
 * SSO 数据开放接口客户端。
 *
 * token 只有 300 秒，缓存到过期前 60 秒；业务接口 401 时强制刷新一次再重试。
 * 所有失败统一抛 `SsoOpenApiError`，`SyncService` 会把它记进 `SyncRun.detail`。
 */
@Injectable()
export class SsoOpenApiClient {
  private tokenCache: TokenCache | null = null;
  private dispatcher: Agent | null = null;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getOrgDepartments(): Promise<SsoOrgDept[]> {
    const body = await this.request<{ code: number; items: SsoOrgDept[] }>(
      '/open/org/departments',
    );
    return body.items;
  }

  getTeachers(since: Date | null): Promise<SsoTeacher[]> {
    return this.getPaged<SsoTeacher>('/data/teachers', since);
  }

  getStudents(since: Date | null): Promise<SsoStudent[]> {
    return this.getPaged<SsoStudent>('/data/students', since);
  }

  async getClasses(): Promise<SsoClass[]> {
    const body = await this.request<{ code: number; items: SsoClass[] }>(
      '/open/edu/classes',
    );
    return body.items;
  }

  async getEduOrg(): Promise<SsoEduCollege[]> {
    const body = await this.request<{
      code: number;
      items: Array<{ colleges?: SsoEduCollege[] }>;
    }>('/open/edu/org');

    return body.items.flatMap((school) => school.colleges ?? []);
  }

  private async getPaged<T>(
    path: string,
    since: Date | null,
  ): Promise<T[]> {
    const pageSize = this.config.getOrThrow('sso.syncPageSize', {
      infer: true,
    });
    const items: T[] = [];

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = await this.request<SsoPage<T>>(path, {
        page,
        pageSize,
        ...(since === null ? {} : { updateTime: since.getTime() }),
      });

      items.push(...body.items);
      if (body.items.length === 0 || page >= body.totalPages) {
        break;
      }
    }

    return items;
  }

  private async request<T>(
    path: string,
    query: Record<string, string | number> = {},
  ): Promise<T> {
    const baseUrl = this.config.getOrThrow('sso.baseUrl', { infer: true });
    const prefix = this.config.getOrThrow('sso.openApiPrefix', { infer: true });
    const url = new URL(`${baseUrl}${prefix}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }

    const first = await this.send<T>(url);
    if (first.status !== 401) {
      return first.body;
    }

    // token 过期 / 被撤销：强制刷新一次再重试。只重试一次，避免上游 401 循环。
    this.tokenCache = null;
    const second = await this.send<T>(url);
    if (second.status !== 401) {
      return second.body;
    }
    throw new SsoOpenApiError(401, 'SSO 开放接口令牌无效');
  }

  private async send<T>(
    url: URL,
  ): Promise<{ status: number; body: T }> {
    const token = await this.getToken();
    const timeoutMs = this.config.getOrThrow('sso.apiLoginTimeoutMs', {
      infer: true,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
        ...(this.getDispatcher() === null
          ? {}
          : { dispatcher: this.getDispatcher() }),
      } as RequestInit & { dispatcher?: Agent });
    } catch (error: unknown) {
      throw new SsoOpenApiError(
        null,
        error instanceof Error ? error.message : String(error),
      );
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new SsoOpenApiError(response.status, 'SSO 开放接口返回的不是 JSON');
    }

    const code = readCode(parsed);
    // 401 交给 request() 处理：刷新 token 后重试一次。这里不抛，
    // 否则重试分支永远走不到。
    if (response.status === 401) {
      return { status: 401, body: parsed as T };
    }
    if (!response.ok || code !== 200) {
      throw new SsoOpenApiError(response.status, readMsg(parsed));
    }

    return { status: response.status, body: parsed as T };
  }

  private async getToken(force = false): Promise<string> {
    if (
      !force &&
      this.tokenCache !== null &&
      this.tokenCache.expiresAt > Date.now()
    ) {
      return this.tokenCache.token;
    }

    const baseUrl = this.config.getOrThrow('sso.baseUrl', { infer: true });
    const prefix = this.config.getOrThrow('sso.openApiPrefix', { infer: true });
    const appId = this.config.getOrThrow('sso.appId', { infer: true });
    const appSecret = this.config.getOrThrow('sso.appSecret', { infer: true });
    const timeoutMs = this.config.getOrThrow('sso.apiLoginTimeoutMs', {
      infer: true,
    });

    const timestamp = Math.floor(Date.now() / 1000);
    const sign = buildOpenApiSign(appId, timestamp, appSecret);

    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}${prefix}/auth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ appId, appSecret, timestamp, sign }),
        signal: AbortSignal.timeout(timeoutMs),
        ...(this.getDispatcher() === null
          ? {}
          : { dispatcher: this.getDispatcher() }),
      } as RequestInit & { dispatcher?: Agent });
    } catch (error: unknown) {
      throw new SsoOpenApiError(
        null,
        error instanceof Error ? error.message : String(error),
      );
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new SsoOpenApiError(response.status, 'SSO token 响应不是 JSON');
    }

    const token = readString(parsed, 'token');
    const expiresIn = readNumber(parsed, 'expiresIn');
    if (!response.ok || token === null || expiresIn === null) {
      throw new SsoOpenApiError(response.status, readMsg(parsed));
    }

    // 提前 60 秒过期；expiresIn 本来就不足 60 秒时取一半，避免缓存成负数
    const ttlMs = Math.max(expiresIn - 60, Math.floor(expiresIn / 2)) * 1000;
    this.tokenCache = { token, expiresAt: Date.now() + ttlMs };
    return token;
  }

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
    this.dispatcher = new Agent({
      connect: { ca: readFileSync(caCertPath, 'utf8') },
    });
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

function readString(body: unknown, key: string): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readNumber(body: unknown, key: string): number | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
}
