export interface AppConfig {
  port: number;
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

export default (): AppConfig => {
  const env = process.env;

  return {
    port: Number(env.PORT ?? 3000),
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
