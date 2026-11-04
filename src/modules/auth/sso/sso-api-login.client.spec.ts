import { createHmac, generateKeyPairSync } from 'node:crypto';
import { classifySsoFailure } from './sso-error';
import { buildApiLoginSign, SsoApiLoginClient } from './sso-api-login.client';
import { SsoRateLimiter } from './sso-rate-limiter.service';

describe('buildApiLoginSign', () => {
  it('按 clientId:username:timestamp:nonce 做 HMAC-SHA256 hex', () => {
    const expected = createHmac('sha256', 'secret')
      .update('app_x:T001:1780371234567:nonce123')
      .digest('hex');
    expect(
      buildApiLoginSign('app_x', 'T001', 1780371234567, 'nonce123', 'secret'),
    ).toBe(expected);
  });
});

describe('classifySsoFailure', () => {
  it('HTTP 200 + code 500 + 账号或密码错误 → credentials', () => {
    expect(
      classifySsoFailure({
        httpStatus: 200,
        body: { code: 500, msg: '账号或密码错误' },
      }),
    ).toBe('credentials');
  });

  it('账号已被锁定 → locked', () => {
    expect(
      classifySsoFailure({
        httpStatus: 200,
        body: { code: 500, msg: '账号已被锁定，请15分钟后再试' },
      }),
    ).toBe('locked');
  });

  it('应用已被禁用 / 签名校验失败 → config', () => {
    expect(
      classifySsoFailure({
        httpStatus: 200,
        body: { code: 500, msg: '应用已被禁用' },
      }),
    ).toBe('config');
    expect(
      classifySsoFailure({
        httpStatus: 200,
        body: { code: 500, msg: '签名校验失败' },
      }),
    ).toBe('config');
  });

  it('网络 cause → unavailable', () => {
    expect(
      classifySsoFailure({
        httpStatus: null,
        body: null,
        cause: new TypeError('fetch failed'),
      }),
    ).toBe('unavailable');
  });

  it('HTTP 5xx → unavailable', () => {
    expect(classifySsoFailure({ httpStatus: 502, body: null })).toBe(
      'unavailable',
    );
  });

  it('未知 msg → invalid', () => {
    expect(
      classifySsoFailure({
        httpStatus: 200,
        body: { code: 500, msg: '未知错误' },
      }),
    ).toBe('invalid');
  });
});

describe('SsoApiLoginClient', () => {
  function clientWithMode(
    fetchImpl: typeof fetch,
    mode: 'plain' | 'rsa' = 'plain',
  ) {
    const values: Record<string, unknown> = {
      'sso.baseUrl': 'https://sso.test',
      'sso.appId': 'app_x',
      'sso.appSecret': 'secret',
      'sso.appSecretMode': mode,
      'sso.apiLoginPath': '/sso/login/api-login',
      'sso.publicKeyPath': '/sso/app/public-key',
      'sso.apiLoginTimeoutMs': 1000,
      'sso.caCertPath': '',
    };
    const get = (key: string): unknown => values[key];
    const config = { get, getOrThrow: get } as never;
    const limiter = {
      consume: jest.fn().mockResolvedValue(undefined),
    } as never;
    return new SsoApiLoginClient(config, limiter, fetchImpl);
  }

  function clientWith(fetchImpl: typeof fetch) {
    return clientWithMode(fetchImpl, 'plain');
  }

  it('成功 → 解析 user', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 200,
          user: {
            userName: 'T001',
            nickName: '张明远',
            userType: 'teacher',
            dept: { deptId: '10', deptName: '计算机学院' },
            isDefaultPwd: false,
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await clientWith(fetchImpl).login('T001', 'Passw0rd!');

    expect(result.user).toMatchObject({
      userName: 'T001',
      nickName: '张明远',
      userType: 'teacher',
      deptId: '10',
      deptName: '计算机学院',
      isDefaultPwd: false,
    });
  });

  it('凭据错误 → SsoApiError(kind=credentials)，不重试', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 500, msg: '账号或密码错误' }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;

    await expect(
      clientWith(fetchImpl).login('T001', 'bad'),
    ).rejects.toMatchObject({ kind: 'credentials' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('网络错误 → SsoApiError(kind=unavailable)', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValue(
        new TypeError('fetch failed'),
      ) as unknown as typeof fetch;

    await expect(
      clientWith(fetchImpl).login('T001', 'x'),
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('RSA 模式：公钥获取网络失败 → unavailable（仍可回退本地密码）', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValue(
        new TypeError('fetch failed'),
      ) as unknown as typeof fetch;

    await expect(
      clientWithMode(fetchImpl, 'rsa').login('T001', 'x'),
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('RSA 模式：成功加密 appSecret 后登录', async () => {
    const { publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    let loginBody: Record<string, unknown> | null = null;

    const fetchImpl = jest.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/sso/app/public-key')) {
        return new Response(JSON.stringify({ publicKey }), { status: 200 });
      }
      loginBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          code: 200,
          user: {
            userName: 'T001',
            nickName: '张明远',
            userType: 'teacher',
            dept: { deptId: '10', deptName: '计算机学院' },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await clientWithMode(fetchImpl, 'rsa').login(
      'T001',
      'Passw0rd!',
    );

    expect(result.user.userName).toBe('T001');
    expect(loginBody).not.toBeNull();
    expect(typeof loginBody!.appSecret).toBe('string');
    expect(loginBody!.appKey).toBeUndefined();
  });

  it('3xx 重定向 → invalid，不跟随', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response('', {
        status: 302,
        headers: { location: 'https://evil.example' },
      }),
    ) as unknown as typeof fetch;

    await expect(
      clientWith(fetchImpl).login('T001', 'x'),
    ).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('RSA 公钥响应无效 → config', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ publicKey: '' }), { status: 200 }),
      ) as unknown as typeof fetch;

    await expect(
      clientWithMode(fetchImpl, 'rsa').login('T001', 'x'),
    ).rejects.toMatchObject({ kind: 'config' });
  });
});

describe('SsoRateLimiter', () => {
  it('超过每分钟上限 → rate_limited', async () => {
    const redis = {
      client: {
        incr: jest.fn().mockResolvedValue(56),
        expire: jest.fn(),
      },
    } as never;
    const limiter = new SsoRateLimiter(redis, {
      getOrThrow: () => 55,
    } as never);

    await expect(limiter.consume()).rejects.toMatchObject({
      kind: 'rate_limited',
    });
  });

  it('窗口内第一次请求 → 设置 60 秒过期', async () => {
    const expire = jest.fn();
    const redis = {
      client: { incr: jest.fn().mockResolvedValue(1), expire },
    } as never;
    const limiter = new SsoRateLimiter(redis, {
      getOrThrow: (key: string) => (key === 'sso.appId' ? 'app_x' : 55),
    } as never);

    await limiter.consume();

    expect(expire).toHaveBeenCalledWith('sso:rate:app_x', 60);
  });
});
