export interface AppConfig {
  port: number;
  app: {
    /**
     * 业务「墙钟时间」的时区（IANA 名，如 `Asia/Shanghai`）。
     *
     * 导师开的时段是「每周重复的墙钟时间」，本身不带时区；预约的
     * `requestedTime` 是 UTC 时刻。比对前必须把后者转成本时区（R31）。
     */
    timezone: string;
    appointmentExpiry: {
      /**
       * 预约超时扫描的定时器是否启动。**不配时按环境走**：`NODE_ENV=test` 关、
       * 其余开。测试要确定性：扫描方法由用例直接调，定时器不该在后台改库态。
       */
      enabled: boolean;
      /** 扫描间隔（秒）。默认 300 */
      intervalSeconds: number;
    };
  };
  database: { url: string };
  redis: { url: string };
  jwt: { secret: string; accessTtlSeconds: number; refreshTtlSeconds: number };
  sso: {
    /** 'mock' = 本地联调用（票据即工号）；'oidc' = 可配置的通用 OIDC。生产只能是 'oidc'（R12） */
    provider: 'mock' | 'oidc';
    authorizeUrl: string;
    tokenUrl: string;
    userinfoUrl: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    /** userinfo 响应里存放工号的字段名；学校文档到位后改这一个值 */
    employeeNoClaim: string;
    /** state 的存活时间（秒）。过期/已用过的 state 一律认作认证失败 */
    stateTtlSeconds: number;
    /** 是否启用后端代理 api-login（SSO-first 登录） */
    loginEnabled: boolean;
    /** SSO 基地址，如 https://sso.csmu.edu.cn */
    baseUrl: string;
    appId: string;
    appSecret: string;
    /** clientSecret 传输方式：RSA 加密（推荐）或明文 appKey */
    appSecretMode: 'rsa' | 'plain';
    apiLoginPath: string;
    publicKeyPath: string;
    apiLoginTimeoutMs: number;
    openApiTimeoutMs: number;
    /** 本地 Redis 令牌桶，默认 55 次/分钟，低于 SSO 单应用 60 次/分钟 */
    rateLimitPerMinute: number;
    fallbackEnabled: boolean;
    fallbackOn5xx: boolean;
    caCertPath: string;
    syncEnabled: boolean;
    /** 是否同步学生。缺 edu:classes 能力键时置 false，先只同步组织+教师 */
    syncStudentsEnabled: boolean;
    openApiPrefix: string;
    syncIntervalSeconds: number;
    syncFullIntervalSeconds: number;
    syncPageSize: number;
    syncDefaultDeptCode: string;
  };
  cors: {
    /** 允许跨域的来源白名单。空数组 = 拒绝一切跨域（fail-closed） */
    origins: string[];
  };
  swagger: {
    /**
     * 在线文档 `/api-docs` 是否挂载。**不配时按环境走**：`NODE_ENV=production` 关、其余开。
     *
     * 关掉的是**这一条路由**，不是契约快照——`docs/openapi.json` 由构建期脚本生成，
     * 与运行时无关，生产照旧有。
     */
    enabled: boolean;
  };
  file: {
    /** 落盘根目录。相对路径按进程 cwd 解析 */
    root: string;
    /** 单个文件的字节上限。超出就是 28103，不是「截断后接受」 */
    maxBytes: number;
  };
  rateLimit: {
    /** 默认限流窗口内的次数上限 */
    defaultLimit: number;
    /** 默认限流窗口长度（秒） */
    defaultWindowSeconds: number;
  };
}

const DEFAULT_SSO_STATE_TTL_SECONDS = 300;

/**
 * `SWAGGER_ENABLED` 的解析。**不配（或空串）时按环境走**：生产关、其余开。
 *
 * 生产默认关的理由：`/api-docs` 不需要登录就能打开，等于把整套接口面
 * （路径、参数、响应形状、错误码表）公开给任何人浏览。
 *
 * 显式 `SWAGGER_ENABLED=1` 可以在生产打开——有的团队内网要留一份。
 * 值不合法时 `validateEnv` 会让进程起不来，这里只管「配了就用」。
 */
function parseSwaggerEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.SWAGGER_ENABLED?.trim().toLowerCase();
  if (raw === undefined || raw === '') {
    return env.NODE_ENV !== 'production';
  }
  return raw === '1' || raw === 'true';
}

/**
 * 通用布尔开关。空串与不配同路（走默认值），`1` / `true` 为真，其余为假。
 * 拼错的值由 `env.validation.ts` 在启动时挡掉，这里只管「配了就用」。
 */
function parseBool(raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '') return fallback;
  return value === '1' || value === 'true';
}

/**
 * `APPOINTMENT_EXPIRY_SCAN_ENABLED` 的解析。不配（或空串）时**测试环境关、
 * 其余开**：e2e 用 `NODE_ENV=test`（Jest 默认置位），定时器不能在后台把用例
 * 造出来的 `0 PENDING` 行扫成 `9 EXPIRED`。扫描方法本身照常可调。
 */
function parseAppointmentExpiryEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.APPOINTMENT_EXPIRY_SCAN_ENABLED?.trim().toLowerCase();
  if (raw === undefined || raw === '') {
    return env.NODE_ENV !== 'test';
  }
  return raw === '1' || raw === 'true';
}

export default (): AppConfig => {
  const env = process.env;

  return {
    port: Number(env.PORT ?? 3000),
    app: {
      // R31：时段是墙钟时间，按本时区解释。空串与不配同路（`||` 而非 `??`）：
      // `Intl.DateTimeFormat` 收到 '' 会抛 RangeError，那会让每个预约请求 500。
      timezone: env.APP_TIMEZONE || 'Asia/Shanghai',
      appointmentExpiry: {
        enabled: parseAppointmentExpiryEnabled(env),
        intervalSeconds: Number(
          env.APPOINTMENT_EXPIRY_SCAN_INTERVAL_SECONDS || 300,
        ),
      },
    },
    database: { url: env.DATABASE_URL as string },
    redis: { url: env.REDIS_URL as string },
    jwt: {
      secret: env.JWT_SECRET as string,
      // 决策 5：access 2h / refresh 7d，均可配。
      // 用 `||` 而不是 `??`：空串要与"不配"同路（env.validation 把 '' 当未配置），
      // Number('') 是 0，会让 access 令牌一签发就过期。
      accessTtlSeconds: Number(env.JWT_ACCESS_TTL_SECONDS || 7200),
      refreshTtlSeconds: Number(env.JWT_REFRESH_TTL_SECONDS || 604800),
    },
    sso: {
      // 默认 mock：本地与 e2e 不必动 .env。生产不显式配 'oidc' 就起不来（R12）
      provider: (env.SSO_PROVIDER ?? 'mock') as 'mock' | 'oidc',
      authorizeUrl: env.SSO_AUTHORIZE_URL ?? '',
      tokenUrl: env.SSO_TOKEN_URL ?? '',
      userinfoUrl: env.SSO_USERINFO_URL ?? '',
      clientId: env.SSO_CLIENT_ID ?? '',
      clientSecret: env.SSO_CLIENT_SECRET ?? '',
      redirectUri: env.SSO_REDIRECT_URI ?? '',
      employeeNoClaim: env.SSO_EMPLOYEE_NO_CLAIM ?? 'employeeNo',
      stateTtlSeconds: Number(
        env.SSO_STATE_TTL_SECONDS ?? DEFAULT_SSO_STATE_TTL_SECONDS,
      ),
      loginEnabled: parseBool(env.SSO_LOGIN_ENABLED, false),
      baseUrl: env.SSO_BASE_URL ?? '',
      appId: env.SSO_APP_ID ?? '',
      appSecret: env.SSO_APP_SECRET ?? '',
      appSecretMode: (env.SSO_APP_SECRET_MODE ?? 'rsa') as 'rsa' | 'plain',
      apiLoginPath: env.SSO_API_LOGIN_PATH ?? '/sso/login/api-login',
      publicKeyPath: env.SSO_PUBLIC_KEY_PATH ?? '/sso/app/public-key',
      apiLoginTimeoutMs: Number(env.SSO_API_LOGIN_TIMEOUT_MS || 5000),
      openApiTimeoutMs: Number(env.SSO_OPENAPI_TIMEOUT_MS || 10000),
      rateLimitPerMinute: Number(env.SSO_RATE_LIMIT_PER_MINUTE || 55),
      fallbackEnabled: parseBool(env.SSO_FALLBACK_ENABLED, true),
      fallbackOn5xx: parseBool(env.SSO_FALLBACK_ON_5XX, false),
      caCertPath: env.SSO_CA_CERT_PATH ?? '',
      syncEnabled: parseBool(env.SSO_SYNC_ENABLED, false),
      syncStudentsEnabled: parseBool(env.SSO_SYNC_STUDENTS_ENABLED, true),
      openApiPrefix: env.SSO_OPENAPI_PREFIX ?? '/api',
      syncIntervalSeconds: Number(env.SSO_SYNC_INTERVAL_SECONDS || 21600),
      syncFullIntervalSeconds: Number(
        env.SSO_SYNC_FULL_INTERVAL_SECONDS || 604800,
      ),
      syncPageSize: Number(env.SSO_SYNC_PAGE_SIZE || 200),
      syncDefaultDeptCode: env.SSO_SYNC_DEFAULT_DEPT_CODE ?? '',
    },
    cors: {
      origins: (env.CORS_ORIGINS ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== ''),
    },
    swagger: {
      enabled: parseSwaggerEnabled(env),
    },
    file: {
      root: env.FILE_ROOT ?? '.uploads',
      maxBytes: Number(env.FILE_MAX_BYTES || 10 * 1024 * 1024),
    },
    rateLimit: {
      defaultLimit: Number(env.RATE_LIMIT_DEFAULT_LIMIT || 300),
      defaultWindowSeconds: Number(env.RATE_LIMIT_DEFAULT_WINDOW_SECONDS || 60),
    },
  };
};
