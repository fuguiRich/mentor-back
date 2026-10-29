import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { ErrorCode } from '../src/common/constants/error-code';
import { redisKeys } from '../src/infra/redis/redis-keys';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import {
  authedAgent,
  clearRedisKeys,
  clearBusinessTables,
  loginAs,
  seedSuperAdmin,
  type E2eApi,
} from './e2e-helpers';

/**
 * 限流的 e2e 不去发 300 个请求——那既慢又把「边界」糊成一片。
 * 直接把计数器拨到边界上，看这一下放不放行：判据是 `count <= limit`，
 * 一个字符之差就会让第 limit 次请求被自己挡掉。
 */
describe('限流 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let api: E2eApi;
  /** 形如 `rl:u:12:FileController.findPage`，由第一次真实请求捞出来 */
  let bucketKey: string;
  let limit: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);

    await clearBusinessTables(prisma);
    await clearRedisKeys(redis);

    const admin = await seedSuperAdmin(prisma);
    const tokens = await loginAs(app, admin.username, admin.password);
    api = authedAgent(app, tokens.accessToken);

    // 先打一发，把这一桶的键名与额度上限都从响应里读出来
    const warm = await api.get('/files').expect(200);
    limit = Number(warm.headers['x-ratelimit-limit']);
    expect(Number.isFinite(limit)).toBe(true);
    expect(limit).toBeGreaterThan(0);

    const keys = await redis.client.keys(`${redisKeys.rateLimitPrefix}*`);
    const mine = keys.filter((key) => key.includes('FileController.findPage'));
    if (mine.length !== 1) {
      throw new Error(
        `限流桶定位失败：${mine.length} 个候选 → ${mine.join(', ')}`,
      );
    }
    bucketKey = mine[0];
  });

  afterAll(async () => {
    try {
      if (prisma !== undefined) {
        await clearBusinessTables(prisma);
      }
      if (redis !== undefined) {
        await clearRedisKeys(redis);
      }
    } finally {
      if (app !== undefined) {
        await app.close();
      }
    }
  });

  async function setCount(count: number): Promise<void> {
    await redis.client.set(bucketKey, String(count));
    await redis.client.expire(bucketKey, 60);
  }

  it('1. 额度按「人」分桶：键名是 rl:u:<userId>:<类名.方法名>', () => {
    // 不按 IP：高校出口 NAT 后面常常几千个真实用户共用一个 IP
    expect(bucketKey).toMatch(/^rl:u:\d+:FileController\.findPage$/);
    expect(bucketKey).not.toContain('ip:');
  });

  it('2. 三件套响应头在放行时也给全（客户端不必猜什么时候重试）', async () => {
    await setCount(0);
    const response = await api.get('/files').expect(200);
    expect(response.headers['x-ratelimit-limit']).toBe(String(limit));
    // 本次 INCR 到 1，所以 remaining = limit - 1
    expect(response.headers['x-ratelimit-remaining']).toBe(String(limit - 1));
    expect(Number(response.headers['x-ratelimit-reset'])).toBeGreaterThan(0);
  });

  it('3. 边界是 <=：第 limit 次仍然放行（remaining=0）', async () => {
    await setCount(limit - 1);
    const response = await api.get('/files').expect(200);
    expect(response.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('4. 第 limit+1 次 → 429 / 10005', async () => {
    await setCount(limit);
    const response = await api.get('/files').expect(429);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.RATE_LIMITED);
    expect(body.data).toBeNull();
    expect(response.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('5. 429 不影响别的接口——额度桶是按端点分的', async () => {
    await setCount(limit);
    await api.get('/files').expect(429);
    // 换个端点就是另一个桶
    await api.get('/roles').expect(200);
  });

  it('6. 未登录请求按 IP 分桶，键名里是 ip:', async () => {
    const anon = await request(app.getHttpServer() as Server)
      .get('/health')
      .expect(200);
    expect(anon.headers['x-ratelimit-limit']).toBe(String(limit));

    const keys = await redis.client.keys(`${redisKeys.rateLimitPrefix}ip:*`);
    expect(keys.length).toBeGreaterThanOrEqual(1);
  });
});
