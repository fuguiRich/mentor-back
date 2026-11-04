import { validateEnv } from './env.validation';

const VALID_ENV = {
  PORT: '3000',
  DATABASE_URL: 'mysql://root:pw@localhost:3306/db',
  REDIS_URL: 'redis://localhost:6379/0',
  JWT_SECRET: 'x'.repeat(32),
};

describe('validateEnv', () => {
  it('全部必填项齐备时原样返回', () => {
    const result = validateEnv({ ...VALID_ENV });

    expect(result.PORT).toBe(3000);
  });

  it('缺少 DATABASE_URL 时报错并指出变量名', () => {
    const { DATABASE_URL: _omitted, ...rest } = VALID_ENV;

    expect(() => validateEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it('缺少 REDIS_URL 时报错并指出变量名', () => {
    const { REDIS_URL: _omitted, ...rest } = VALID_ENV;

    expect(() => validateEnv(rest)).toThrow(/REDIS_URL/);
  });

  it('PORT 不是数字时报错', () => {
    expect(() => validateEnv({ ...VALID_ENV, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('DATABASE_URL 协议不对时报错', () => {
    expect(() =>
      validateEnv({ ...VALID_ENV, DATABASE_URL: 'postgres://x/y' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('一次性报出全部问题，而不是只报第一个', () => {
    expect(() => validateEnv({ PORT: 'abc' })).toThrow(/DATABASE_URL/);
    expect(() => validateEnv({ PORT: 'abc' })).toThrow(/PORT/);
  });

  it('缺少 JWT_SECRET 时报错并指出变量名', () => {
    const { JWT_SECRET: _omitted, ...rest } = VALID_ENV;

    expect(() => validateEnv(rest)).toThrow(/JWT_SECRET 未配置/);
  });

  it('JWT_SECRET 不足 32 个字符时报错', () => {
    expect(() =>
      validateEnv({ ...VALID_ENV, JWT_SECRET: 'x'.repeat(31) }),
    ).toThrow(/长度不得少于/);
  });

  it.each(['abc', '0', '-1'])(
    'JWT_ACCESS_TTL_SECONDS 为 %s 时报错（必须是正整数秒数）',
    (value) => {
      expect(() =>
        validateEnv({ ...VALID_ENV, JWT_ACCESS_TTL_SECONDS: value }),
      ).toThrow(/JWT_ACCESS_TTL_SECONDS/);
    },
  );

  it('JWT_ACCESS_TTL_SECONDS 不传时走默认值', () => {
    const result = validateEnv({ ...VALID_ENV });

    expect(result.JWT_ACCESS_TTL_SECONDS).toBeUndefined();
  });

  it('JWT_ACCESS_TTL_SECONDS 为空字符串时按不传处理（与 configuration 的 || 同判）', () => {
    expect(() =>
      validateEnv({ ...VALID_ENV, JWT_ACCESS_TTL_SECONDS: '' }),
    ).not.toThrow();
  });

  it('SWAGGER_ENABLED 不传 / 空串 / 合法值都不报错', () => {
    expect(() => validateEnv({ ...VALID_ENV })).not.toThrow();
    expect(() =>
      validateEnv({ ...VALID_ENV, SWAGGER_ENABLED: '' }),
    ).not.toThrow();
    for (const value of ['1', '0', 'true', 'false', 'TRUE', 'False']) {
      expect(() =>
        validateEnv({ ...VALID_ENV, SWAGGER_ENABLED: value }),
      ).not.toThrow();
    }
  });

  it('SWAGGER_ENABLED 拼错时报错——「以为关了其实开着」比启动失败更糟', () => {
    expect(() => validateEnv({ ...VALID_ENV, SWAGGER_ENABLED: 'yes' })).toThrow(
      /SWAGGER_ENABLED/,
    );
  });

  it('SSO_LOGIN_ENABLED=1 但缺 SSO_APP_ID → 抛错', () => {
    expect(() =>
      validateEnv({
        ...VALID_ENV,
        SSO_LOGIN_ENABLED: '1',
        SSO_BASE_URL: 'https://sso.example.edu',
        SSO_APP_SECRET: 'secret',
      }),
    ).toThrow(/SSO_APP_ID/);
  });

  it('SSO_FALLBACK_ON_5XX 不是布尔值 → 抛错', () => {
    expect(() =>
      validateEnv({
        ...VALID_ENV,
        SSO_FALLBACK_ON_5XX: 'yes',
      }),
    ).toThrow(/SSO_FALLBACK_ON_5XX/);
  });
});
