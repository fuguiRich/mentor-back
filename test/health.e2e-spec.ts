import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { HealthController } from '../src/infra/health/health.controller';
import { HealthService } from '../src/infra/health/health.service';
import {
  HealthRepository,
  type ProbeResult,
} from '../src/infra/health/health.repository';

describe('健康检查 (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health 返回数据库与 Redis 均连通', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/health')
      .expect(200);

    expect(response.body).toMatchObject({
      code: 0,
      message: 'ok',
      data: {
        status: 'ok',
        dependencies: {
          database: { status: 'up' },
          redis: { status: 'up' },
        },
      },
    });
  });
});

describe('健康检查降级契约 (e2e)', () => {
  // 手搭测试模块而不是 overrideProvider 全量 AppModule：本组用例测的是
  // controller/service 对「依赖 down」的映射契约，不需要真实 MySQL / Redis，
  // 也避开 override 能否穿透嵌套模块的不确定性。
  async function createApp(
    probeDatabase: () => Promise<ProbeResult>,
    probeRedis: () => Promise<ProbeResult>,
  ): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: HealthRepository, useValue: { probeDatabase, probeRedis } },
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    return app;
  }

  it('两个依赖都 down：HTTP 200 + status error，message 透传', async () => {
    const app = await createApp(
      () => Promise.resolve({ status: 'down', message: '数据库连接被拒绝' }),
      () => Promise.resolve({ status: 'down', message: 'Redis PING 超时' }),
    );

    try {
      const response = await request(app.getHttpServer() as Server)
        .get('/health')
        .expect(200);

      expect(response.body).toMatchObject({
        code: 0,
        message: 'ok',
        data: {
          status: 'error',
          dependencies: {
            database: { status: 'down', message: '数据库连接被拒绝' },
            redis: { status: 'down', message: 'Redis PING 超时' },
          },
        },
      });
    } finally {
      await app.close();
    }
  });

  it('部分降级（一 up 一 down）同样 200 + error——&& 的另一半分支', async () => {
    const app = await createApp(
      () => Promise.resolve({ status: 'up' }),
      () => Promise.resolve({ status: 'down', message: 'Redis PING 超时' }),
    );

    try {
      const response = await request(app.getHttpServer() as Server)
        .get('/health')
        .expect(200);

      expect(response.body).toMatchObject({
        code: 0,
        message: 'ok',
        data: {
          status: 'error',
          dependencies: {
            database: { status: 'up' },
            redis: { status: 'down', message: 'Redis PING 超时' },
          },
        },
      });
    } finally {
      await app.close();
    }
  });
});
