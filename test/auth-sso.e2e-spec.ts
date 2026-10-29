import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ErrorCode } from '../src/common/constants/error-code';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import type { AuthTokensResponseDto } from '../src/modules/auth/dto/auth-tokens.response.dto';
import {
  authedAgent,
  clearRedisKeys,
  clearBusinessTables,
  seedSuperAdmin,
  seedUser,
  type SeededUser,
} from './e2e-helpers';

/**
 * 学校统一认证（SSO）收尾的 e2e。套件骨架照 auth.e2e-spec.ts，
 * 但**不配任何环境变量**——SSO_PROVIDER 默认 mock，本地与 e2e 都不必动 .env。
 *
 * 裁决 R11：callback 回 **200 + JSON 双令牌**，不做 302。
 * 裁决 R12 的启动失败性质由 env.validation 单测覆盖（这里只跑默认 mock 路径）。
 */
describe('学校统一认证 SSO (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let admin: SeededUser;

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

    admin = await seedSuperAdmin(prisma);
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

  /** 取一个带 state 的 authorize URL，并把 state 解出来 */
  async function fetchAuthorizeState(): Promise<{
    authorizeUrl: string;
    state: string;
  }> {
    const response = await request(app.getHttpServer() as Server)
      .get('/auth/sso/authorize')
      .expect(200);

    const body = response.body as ResponseEnvelope<{ authorizeUrl: string }>;
    const authorizeUrl = body.data.authorizeUrl;

    // mock provider 的 URL 形如 `<base>?state=<state>&ticket=%7BemployeeNo%7D`
    const parsed = new URL(authorizeUrl, 'http://localhost');
    const state = parsed.searchParams.get('state');
    if (state === null) {
      throw new Error(`authorizeUrl 里没有 state：${authorizeUrl}`);
    }

    return { authorizeUrl, state };
  }

  it('GET /auth/sso/authorize 未登录可用 → 200，authorizeUrl 含 state=', async () => {
    const { authorizeUrl, state } = await fetchAuthorizeState();

    expect(typeof authorizeUrl).toBe('string');
    expect(authorizeUrl).toContain('state=');
    expect(state.length).toBeGreaterThan(0);
  });

  it('callback 成功 → 200 + JSON 双令牌（R11，不是 302）', async () => {
    const { state } = await fetchAuthorizeState();

    const response = await request(app.getHttpServer() as Server)
      .get('/auth/sso/callback')
      .query({ state, ticket: admin.username })
      .expect(200);

    // R11 的可观察面：是 200 + JSON，不是 302。
    // supertest 的 .expect(200) 已经挡掉了 302；这里再把 Location 头单独钉死，
    // 免得将来有人改成「200 但带 Location」的折中形态。
    expect(response.headers.location).toBeUndefined();

    const body = response.body as ResponseEnvelope<AuthTokensResponseDto>;
    expect(body.code).toBe(0);
    expect(typeof body.data.accessToken).toBe('string');
    expect(typeof body.data.refreshToken).toBe('string');
    expect(typeof body.data.expiresIn).toBe('number');
  });

  it('拿到的双令牌能用：GET /auth/profile → 200', async () => {
    const { state } = await fetchAuthorizeState();
    const callback = await request(app.getHttpServer() as Server)
      .get('/auth/sso/callback')
      .query({ state, ticket: admin.username })
      .expect(200);

    const tokens = (callback.body as ResponseEnvelope<AuthTokensResponseDto>)
      .data;

    const profile = await authedAgent(app, tokens.accessToken)
      .get('/auth/profile')
      .expect(200);
    const body = profile.body as ResponseEnvelope<{
      user: { username: string };
    }>;
    expect(body.data.user.username).toBe(admin.username);
  });

  it('state 一次性：同一 state 再回调 → 400 / 20106', async () => {
    const { state } = await fetchAuthorizeState();

    await request(app.getHttpServer() as Server)
      .get('/auth/sso/callback')
      .query({ state, ticket: admin.username })
      .expect(200);

    // 同一 state 第二次必定失败（票据重放的第一道闸）
    const replay = await request(app.getHttpServer() as Server)
      .get('/auth/sso/callback')
      .query({ state, ticket: admin.username })
      .expect(400);

    expect((replay.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.AUTH_SSO_STATE_INVALID,
    );
  });

  it('state 不认识 → 400 / 20106', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/auth/sso/callback')
      .query({ state: 'never-issued-state', ticket: admin.username })
      .expect(400);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.AUTH_SSO_STATE_INVALID,
    );
  });

  it('本地无此工号 → 403 / 20107，且库里没有多出用户（不自动建号）', async () => {
    const before = await prisma.client.sysUser.count();

    const { state } = await fetchAuthorizeState();
    const response = await request(app.getHttpServer() as Server)
      .get('/auth/sso/callback')
      .query({ state, ticket: 'NO_SUCH_EMP' })
      .expect(403);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.AUTH_SSO_USER_UNKNOWN,
    );

    const after = await prisma.client.sysUser.count();
    expect(after).toBe(before);
  });

  it('本地有但已停用 → 401 / 20102', async () => {
    const root = await prisma.client.sysDept.findFirst({
      where: { name: '总公司' },
    });
    if (root === null) {
      throw new Error('seedSuperAdmin 未种出「总公司」部门');
    }
    const disabled = await seedUser(prisma, {
      username: 'sso-disabled',
      deptId: root.id,
      status: 0,
    });

    const { state } = await fetchAuthorizeState();
    const response = await request(app.getHttpServer() as Server)
      .get('/auth/sso/callback')
      .query({ state, ticket: disabled.username })
      .expect(401);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.AUTH_ACCOUNT_DISABLED,
    );
  });

  it('上游带回 error=access_denied → 400 / 20106（不换票据）', async () => {
    const { state } = await fetchAuthorizeState();
    const response = await request(app.getHttpServer() as Server)
      .get('/auth/sso/callback')
      .query({ state, ticket: 'anything', error: 'access_denied' })
      .expect(400);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.AUTH_SSO_STATE_INVALID,
    );
  });

  it('真实拒绝回调：只有 state + error、**没有** ticket → 400 / 20106（不是 10001）', async () => {
    // RFC 6749 的错误重定向形如 `GET /callback?state=X&error=access_denied`，
    // 压根没有 ticket。ticket 之前是必填，这种请求会死在 DTO 管道里回 10001，
    // 服务端那句「有 error 就不换票据、直接回统一认证失败」根本走不到。
    const { state } = await fetchAuthorizeState();
    const response = await request(app.getHttpServer() as Server)
      .get('/auth/sso/callback')
      .query({ state, error: 'access_denied' })
      .expect(400);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.AUTH_SSO_STATE_INVALID,
    );
  });
});
