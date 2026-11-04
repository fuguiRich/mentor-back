import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import {
  authedAgent,
  clearBusinessTables,
  clearRedisKeys,
  loginAs,
  seedSuperAdmin,
  seedUser,
  type SeededUser,
} from './e2e-helpers';

async function clearSyncTables(prisma: PrismaService): Promise<void> {
  const tables = ['sync_person', 'sync_org_unit', 'sync_run'];
  for (const table of tables) {
    await prisma.client.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
}

describe('SSO 同步管理入口 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let admin: SeededUser;
  let normal: SeededUser;

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
    await clearSyncTables(prisma);
    await clearRedisKeys(redis);

    admin = await seedSuperAdmin(prisma);
    const root = await prisma.client.sysDept.findFirst({
      where: { name: '总公司' },
    });
    if (root === null) throw new Error('seedSuperAdmin 未种出根部门');
    normal = await seedUser(prisma, {
      username: 'normal-user',
      deptId: root.id,
    });
  });

  afterAll(async () => {
    try {
      if (prisma !== undefined) {
        await clearBusinessTables(prisma);
        await clearSyncTables(prisma);
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

  it('超管 POST /sync/sso/run → 202 + runId', async () => {
    const tokens = await loginAs(app, admin.username, admin.password);
    const response = await authedAgent(app, tokens.accessToken)
      .post('/sync/sso/run')
      .send({ mode: 'full' })
      .expect(202);

    const body = response.body as ResponseEnvelope<{ runId: string }>;
    expect(body.data.runId).toMatch(/^\d+$/);
  });

  it('普通用户 POST /sync/sso/run → 403', async () => {
    const tokens = await loginAs(app, normal.username, normal.password);
    await authedAgent(app, tokens.accessToken)
      .post('/sync/sso/run')
      .send({ mode: 'incremental' })
      .expect(403);
  });

  it('GET /sync/runs?source=sso → 返回分页流水', async () => {
    const tokens = await loginAs(app, admin.username, admin.password);
    const response = await authedAgent(app, tokens.accessToken)
      .get('/sync/runs?source=sso&page=1&pageSize=10')
      .expect(200);

    const body = response.body as ResponseEnvelope<{
      rows: Array<{ source: string; mode: string | null }>;
    }>;
    expect(Array.isArray(body.data.rows)).toBe(true);
  });
});
