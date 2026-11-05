/**
 * SSO api-login 的失败分类。
 *
 * 对调用者（AuthService）来说，最重要的区分不是「上游返回了什么字符串」，而是
 * **这次失败能不能回退本地密码**：
 *
 * - `credentials` / `locked` / `rate_limited` / `config` / `invalid`：SSO 已经
 *   明确表态，回退会绕过 SSO 的密码策略与锁定，**一律不回退**。
 * - `unavailable`：只有网络层不可达（超时 / DNS / 连接失败 / TLS）或 HTTP 5xx
 *   才会到这里；是否回退由 `sso.fallbackEnabled` / `sso.fallbackOn5xx` 决定。
 *
 * 原始 `msg` 只用于日志与排查，不直接回显给用户；对外文案由错误码表统一给。
 */
export type SsoFailureKind =
  | 'credentials'
  | 'locked'
  | 'rate_limited'
  | 'config'
  | 'unavailable'
  | 'invalid';

export class SsoApiError extends Error {
  readonly kind: SsoFailureKind;
  readonly httpStatus: number | null;
  readonly ssoCode: number | null;
  readonly ssoMsg: string | null;

  constructor(
    kind: SsoFailureKind,
    message: string,
    httpStatus: number | null = null,
    ssoCode: number | null = null,
    ssoMsg: string | null = null,
  ) {
    super(message);
    this.name = 'SsoApiError';
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.ssoCode = ssoCode;
    this.ssoMsg = ssoMsg;
  }
}

/** 把上游的失败响应归类。**纯函数**：不抛、不读环境，方便单测钉住每一条映射。 */
export function classifySsoFailure(input: {
  httpStatus: number | null;
  body: unknown;
  cause?: unknown;
}): SsoFailureKind {
  if (input.httpStatus === null || input.cause !== undefined) {
    return 'unavailable';
  }
  if (input.httpStatus >= 500) {
    return 'unavailable';
  }
  if (input.httpStatus >= 400) {
    return 'invalid';
  }

  const msg = readMsg(input.body);
  if (msg === null) {
    return 'invalid';
  }

  // 文档示例写「账号或密码错误」，真实 SSO 返回「用户名或密码错误」——
  // 两种都要认，否则会把凭据拒绝误判成 invalid（20111）。
  if (
    msg.includes('账号或密码错误') ||
    msg.includes('用户名或密码错误')
  ) {
    return 'credentials';
  }
  if (msg.includes('账号已被锁定')) {
    return 'locked';
  }
  if (msg.includes('请求过于频繁')) {
    return 'rate_limited';
  }
  if (
    [
      '应用已被禁用',
      '应用密钥错误',
      '签名校验失败',
      '缺少签名参数',
      '请求已过期',
      '请求已使用',
    ].some((token) => msg.includes(token))
  ) {
    return 'config';
  }

  return 'invalid';
}

function readMsg(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const msg = (body as { msg?: unknown }).msg;
  return typeof msg === 'string' && msg.trim() !== '' ? msg.trim() : null;
}
