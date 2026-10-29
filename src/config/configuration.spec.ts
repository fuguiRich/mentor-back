import configuration from './configuration';

describe('configuration jwt 时长', () => {
  it('JWT_*_TTL_SECONDS 为空字符串时与不配一致：走默认 7200 / 604800', () => {
    // Number('') 是 0：若把 '' 当成"配了 0"，令牌一签发就过期。
    // 空串必须与"不配"同一条路（env.validation 也是这么判的）。
    const prevAccess = process.env.JWT_ACCESS_TTL_SECONDS;
    const prevRefresh = process.env.JWT_REFRESH_TTL_SECONDS;
    process.env.JWT_ACCESS_TTL_SECONDS = '';
    process.env.JWT_REFRESH_TTL_SECONDS = '';

    try {
      const config = configuration();
      expect(config.jwt.accessTtlSeconds).toBe(7200);
      expect(config.jwt.refreshTtlSeconds).toBe(604800);
    } finally {
      if (prevAccess === undefined) {
        delete process.env.JWT_ACCESS_TTL_SECONDS;
      } else {
        process.env.JWT_ACCESS_TTL_SECONDS = prevAccess;
      }
      if (prevRefresh === undefined) {
        delete process.env.JWT_REFRESH_TTL_SECONDS;
      } else {
        process.env.JWT_REFRESH_TTL_SECONDS = prevRefresh;
      }
    }
  });
});

describe('configuration swagger.enabled', () => {
  const KEYS = ['SWAGGER_ENABLED', 'NODE_ENV'] as const;

  /** 在给定的环境变量下跑一次断言，跑完**无条件**还原（断言失败也不污染后续用例） */
  function withEnv(
    overrides: Partial<Record<(typeof KEYS)[number], string>>,
    run: () => void,
  ): void {
    const previous = new Map<string, string | undefined>();
    for (const key of KEYS) {
      previous.set(key, process.env[key]);
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }

    try {
      run();
    } finally {
      for (const key of KEYS) {
        const value = previous.get(key);
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  it('不配时按环境走：生产关、其余开', () => {
    withEnv({}, () => {
      expect(configuration().swagger.enabled).toBe(true);
    });
    withEnv({ NODE_ENV: 'production' }, () => {
      expect(configuration().swagger.enabled).toBe(false);
    });
  });

  it('显式 SWAGGER_ENABLED 覆盖环境默认（生产也能开，非生产也能关）', () => {
    withEnv({ NODE_ENV: 'production', SWAGGER_ENABLED: '1' }, () => {
      expect(configuration().swagger.enabled).toBe(true);
    });
    withEnv({ SWAGGER_ENABLED: '0' }, () => {
      expect(configuration().swagger.enabled).toBe(false);
    });
  });

  it('空字符串与不配同路（不把空串当成 false）', () => {
    withEnv({ SWAGGER_ENABLED: '' }, () => {
      expect(configuration().swagger.enabled).toBe(true);
    });
    withEnv({ NODE_ENV: 'production', SWAGGER_ENABLED: '' }, () => {
      expect(configuration().swagger.enabled).toBe(false);
    });
  });
});
