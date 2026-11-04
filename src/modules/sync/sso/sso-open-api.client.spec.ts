import { createHash } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../../config/configuration';
import { buildOpenApiSign, SsoOpenApiClient } from './sso-open-api.client';

function makeClient(fetchImpl: typeof fetch): SsoOpenApiClient {
  const values: Record<string, unknown> = {
    'sso.baseUrl': 'https://sso.test',
    'sso.openApiPrefix': '/api',
    'sso.appId': 'app_x',
    'sso.appSecret': 'secret',
    'sso.syncPageSize': 200,
    'sso.apiLoginTimeoutMs': 1000,
    'sso.caCertPath': '',
  };
  const config = {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => values[key],
  } as unknown as ConfigService<AppConfig, true>;
  return new SsoOpenApiClient(config, fetchImpl);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('buildOpenApiSign', () => {
  it('sign = MD5(appId=...&timestamp=...&key=...).toUpperCase()', () => {
    const expected = createHash('md5')
      .update('appId=app_x&timestamp=1780371234&key=secret')
      .digest('hex')
      .toUpperCase();
    expect(buildOpenApiSign('app_x', 1780371234, 'secret')).toBe(expected);
  });
});

describe('SsoOpenApiClient', () => {
  it('token 缓存；业务接口 401 时刷新一次并重试', async () => {
    const calls: string[] = [];
    const fetchImpl = jest.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('/auth/token')) {
        return json({ code: 200, token: 't1', expiresIn: 300 });
      }
      if (calls.filter((u) => u.includes('/data/teachers')).length === 1) {
        return json({}, 401);
      }
      return json({
        code: 200,
        total: 1,
        page: 1,
        pageSize: 200,
        totalPages: 1,
        items: [{ workId: 'T1', name: '张三', organization: '计算机学院' }],
      });
    }) as unknown as typeof fetch;

    const teachers = await makeClient(fetchImpl).getTeachers(null);

    expect(teachers).toHaveLength(1);
    expect(calls.filter((u) => u.endsWith('/auth/token'))).toHaveLength(2);
  });

  it('分页：totalPages=3 时拉三页', async () => {
    const pages: number[] = [];
    const fetchImpl = jest.fn(async (url: string) => {
      if (url.endsWith('/auth/token')) {
        return json({ code: 200, token: 't', expiresIn: 300 });
      }
      const page = Number(new URL(url).searchParams.get('page'));
      pages.push(page);
      return json({
        code: 200,
        total: 3,
        page,
        pageSize: 1,
        totalPages: 3,
        items: [{ workId: `T${page}`, name: `教师${page}`, organization: '计算机学院' }],
      });
    }) as unknown as typeof fetch;

    const teachers = await makeClient(fetchImpl).getTeachers(null);

    expect(pages).toEqual([1, 2, 3]);
    expect(teachers.map((t) => t.workId)).toEqual(['T1', 'T2', 'T3']);
  });

  it('updateTime 传毫秒时间戳', async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      if (url.includes('/data/students')) {
        expect(new URL(url).searchParams.get('updateTime')).toBe(
          '1780371234000',
        );
        return json({
          code: 200,
          total: 0,
          page: 1,
          pageSize: 200,
          totalPages: 0,
          items: [],
        });
      }
      return json({ code: 200, token: 't', expiresIn: 300 });
    }) as unknown as typeof fetch;

    await makeClient(fetchImpl).getStudents(new Date(1780371234000));
  });

  it('非 2xx / code !== 200 → SsoOpenApiError', async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      if (url.endsWith('/auth/token')) {
        return json({ code: 200, token: 't', expiresIn: 300 });
      }
      return json({ code: 403, msg: '没有权限访问此API' }, 403);
    }) as unknown as typeof fetch;

    await expect(makeClient(fetchImpl).getClasses()).rejects.toMatchObject({
      status: 403,
      msg: '没有权限访问此API',
    });
  });
});
