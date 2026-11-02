const REQUIRED_KEYS = ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET'] as const;

export const JWT_SECRET_MIN_LENGTH = 32;

/**
 * 启动时校验环境变量。缺项、类型不对、协议不对都直接抛错让进程起不来——
 * 配置错误的服务能启动，故障会推迟到第一个请求才暴露，那时的现象与根因隔了很远。
 */
export function validateEnv(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const problems: string[] = [];

  for (const key of REQUIRED_KEYS) {
    const value = raw[key];
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`${key} 未配置`);
    }
  }

  const databaseUrl = raw.DATABASE_URL;
  if (typeof databaseUrl === 'string' && !databaseUrl.startsWith('mysql://')) {
    problems.push('DATABASE_URL 必须以 mysql:// 开头');
  }

  const redisUrl = raw.REDIS_URL;
  if (typeof redisUrl === 'string' && !redisUrl.startsWith('redis://')) {
    problems.push('REDIS_URL 必须以 redis:// 开头');
  }

  const ssoProvider: unknown = raw.SSO_PROVIDER ?? 'mock';
  if (ssoProvider !== 'mock' && ssoProvider !== 'oidc') {
    problems.push(
      `SSO_PROVIDER 只能是 mock 或 oidc：${String(raw.SSO_PROVIDER)}`,
    );
  }

  // R12：mock provider 的语义是"给个工号就发令牌"。它在生产里被启用 = 任何人可登录。
  // 让配置错误的服务**起不来**，与本文件开头的原则一致（env.validation.ts:5-7）。
  if (ssoProvider === 'mock' && raw.NODE_ENV === 'production') {
    problems.push(
      'SSO_PROVIDER=mock 在 NODE_ENV=production 下不可用：mock 会跳过真实认证，等于任何人可登录。生产请配 SSO_PROVIDER=oidc',
    );
  }

  if (ssoProvider === 'oidc') {
    for (const key of [
      'SSO_AUTHORIZE_URL',
      'SSO_TOKEN_URL',
      'SSO_USERINFO_URL',
      'SSO_CLIENT_ID',
      'SSO_CLIENT_SECRET',
      'SSO_REDIRECT_URI',
    ] as const) {
      const value = raw[key];
      if (typeof value !== 'string' || value.trim() === '') {
        problems.push(`SSO_PROVIDER=oidc 时 ${key} 必须配置`);
      }
    }
  }

  const ssoStateTtl = Number(raw.SSO_STATE_TTL_SECONDS ?? 300);
  if (!Number.isInteger(ssoStateTtl) || ssoStateTtl <= 0) {
    problems.push(
      `SSO_STATE_TTL_SECONDS 必须是正整数：${String(raw.SSO_STATE_TTL_SECONDS)}`,
    );
  }

  const corsRaw = raw.CORS_ORIGINS;
  const corsOrigins = (typeof corsRaw === 'string' ? corsRaw : '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');

  if (raw.NODE_ENV === 'production' && corsOrigins.length === 0) {
    problems.push(
      'CORS_ORIGINS 未配置：生产环境不配白名单会让前端跨域请求全部被拒（fail-closed）。请用逗号分隔列出允许的来源',
    );
  }

  for (const origin of corsOrigins) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(origin);
    } catch {
      problems.push(`CORS_ORIGINS 里有不是合法 URL 的项：${origin}`);
      continue;
    }
    if (origin !== parsed.origin) {
      problems.push(
        `CORS_ORIGINS 的项必须是「协议 + 主机 + 端口」，不含路径：${origin}`,
      );
    }
  }

  const swaggerRaw = raw.SWAGGER_ENABLED;
  const swaggerValue =
    typeof swaggerRaw === 'string' ? swaggerRaw.trim().toLowerCase() : '';
  if (
    swaggerValue !== '' &&
    !['1', '0', 'true', 'false'].includes(swaggerValue)
  ) {
    // 拼错的值最坏的结果是「以为关了其实开着」——在线文档不登录就能看，
    // 所以这里不猜，直接让进程起不来。
    problems.push(
      `SWAGGER_ENABLED 只能是 1 / 0 / true / false：${swaggerValue}`,
    );
  }

  // 超时扫描定时器：拼错开关 = 以为关了其实在扫（或反过来）。同 SWAGGER_ENABLED，
  // 不猜，让进程起不来。
  const expiryScanRaw = raw.APPOINTMENT_EXPIRY_SCAN_ENABLED;
  const expiryScanValue =
    typeof expiryScanRaw === 'string' ? expiryScanRaw.trim().toLowerCase() : '';
  if (
    expiryScanValue !== '' &&
    !['1', '0', 'true', 'false'].includes(expiryScanValue)
  ) {
    problems.push(
      `APPOINTMENT_EXPIRY_SCAN_ENABLED 只能是 1 / 0 / true / false：${expiryScanValue}`,
    );
  }

  const expiryIntervalRaw = raw.APPOINTMENT_EXPIRY_SCAN_INTERVAL_SECONDS;
  if (expiryIntervalRaw !== undefined && expiryIntervalRaw !== '') {
    const seconds = Number(expiryIntervalRaw);
    if (!Number.isInteger(seconds) || seconds <= 0) {
      problems.push(
        `APPOINTMENT_EXPIRY_SCAN_INTERVAL_SECONDS 必须是正整数秒数：${String(raw.APPOINTMENT_EXPIRY_SCAN_INTERVAL_SECONDS)}`,
      );
    }
  }

  const port = Number(raw.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    problems.push(`PORT 不是合法端口号：${String(raw.PORT)}`);
  }

  const jwtSecret = raw.JWT_SECRET;
  if (
    typeof jwtSecret === 'string' &&
    jwtSecret.length < JWT_SECRET_MIN_LENGTH
  ) {
    problems.push(
      `JWT_SECRET 长度不得少于 ${JWT_SECRET_MIN_LENGTH} 个字符（当前 ${jwtSecret.length}）`,
    );
  }

  // 时长为正整数秒。写成 0 / 负数 / '2h' 都让进程起不来——
  // 静默取默认值会让"我明明配了"与"实际生效的"分叉，且没有任何东西会说话。
  for (const key of [
    'JWT_ACCESS_TTL_SECONDS',
    'JWT_REFRESH_TTL_SECONDS',
  ] as const) {
    const value = raw[key];
    if (value === undefined || value === '') {
      continue;
    }

    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds <= 0) {
      // 与 PORT 同款写法：直接插值 unknown 会撞 no-base-to-string
      problems.push(`${key} 必须是正整数秒数：${String(raw[key])}`);
    }
  }

  // 与 JWT_*_TTL 同款：0 / 负数 / '10mb' 都让进程起不来，静默取默认值
  // 会让「我明明配了」与「实际生效的」分叉，且没有任何机制会说话。
  for (const key of [
    'FILE_MAX_BYTES',
    'RATE_LIMIT_DEFAULT_LIMIT',
    'RATE_LIMIT_DEFAULT_WINDOW_SECONDS',
  ] as const) {
    const value = raw[key];
    if (value === undefined || value === '') {
      continue;
    }

    const amount = Number(value);
    if (!Number.isInteger(amount) || amount <= 0) {
      problems.push(`${key} 必须是正整数：${String(raw[key])}`);
    }
  }

  // R31：时段的墙钟时间按这个时区解释。拼错（如 `Asia/Shanghai ` 带空格、
  // `GMT+8` 这种非 IANA 名）不会在配置层报错，只会在每次预约比对时抛
  // RangeError——让进程起不来，比让每个预约请求 500 好。
  const timezone = raw.APP_TIMEZONE;
  if (typeof timezone === 'string' && timezone.trim() !== '') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      problems.push(`APP_TIMEZONE 不是合法的 IANA 时区名：${timezone}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`环境变量校验失败：\n  - ${problems.join('\n  - ')}`);
  }

  return { ...raw, PORT: port };
}
