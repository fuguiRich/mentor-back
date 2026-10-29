import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { LOGIN_MAX_ATTEMPTS } from '../src/common/constants/auth.constants';
import { ErrorCode } from '../src/common/constants/error-code';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import type { UserDetailResponseDto } from '../src/modules/user/dto/user-detail-response.dto';
import {
  authedAgent,
  clearRedisKeys,
  clearBusinessTables,
  loginAs,
  seedSuperAdmin,
  seedUser,
  type SeededUser,
} from './e2e-helpers';

describe('认证与默认拒绝 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let admin: SeededUser;
  let normal: SeededUser;
  let normalDeptId: bigint;

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
    const root = await prisma.client.sysDept.findFirst({
      where: { name: '总公司' },
    });
    if (root === null) {
      throw new Error('seedSuperAdmin 未种出「总公司」部门');
    }
    normalDeptId = root.id;
    normal = await seedUser(prisma, {
      username: 'zhangsan',
      deptId: normalDeptId,
    });
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

  it('未登录访问受保护接口 → 401 / 10002', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/depts/tree')
      .expect(401);

    const body = response.body as ResponseEnvelope<null>;

    expect(body.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(body.data).toBeNull();
  });

  it('@Public 的 /health 不需要令牌', async () => {
    await request(app.getHttpServer() as Server)
      .get('/health')
      .expect(200);
  });

  it('@Public 的 /auth/login 不需要令牌', async () => {
    await request(app.getHttpServer() as Server)
      .post('/auth/login')
      .send({ username: admin.username, password: admin.password })
      .expect(200);
  });

  it('缺 Bearer 前缀 → 401', async () => {
    const tokens = await loginAs(app, admin.username, admin.password);
    const response = await request(app.getHttpServer() as Server)
      .get('/depts/tree')
      .set('Authorization', tokens.accessToken) // 少了 "Bearer "
      .expect(401);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.UNAUTHORIZED,
    );
  });

  it('令牌被篡改 → 401', async () => {
    const tokens = await loginAs(app, admin.username, admin.password);
    const tampered = `${tokens.accessToken.slice(0, -1)}x`;

    const response = await request(app.getHttpServer() as Server)
      .get('/depts/tree')
      .set('Authorization', `Bearer ${tampered}`)
      .expect(401);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.UNAUTHORIZED,
    );
  });

  it('登录成功返回双令牌，expiresIn 是 access 的剩余秒数', async () => {
    const response = await request(app.getHttpServer() as Server)
      .post('/auth/login')
      .send({ username: admin.username, password: admin.password })
      .expect(200);

    const body = response.body as ResponseEnvelope<{
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
    }>;

    expect(body.code).toBe(0);
    expect(typeof body.data.accessToken).toBe('string');
    expect(typeof body.data.refreshToken).toBe('string');
    expect(body.data.expiresIn).toBe(7200);
    expect(body.data.accessToken).not.toBe(body.data.refreshToken);
  });

  it('密码错误与用户名不存在返回**完全相同**的错误体', async () => {
    const wrongPassword = await request(app.getHttpServer() as Server)
      .post('/auth/login')
      .send({ username: admin.username, password: 'wrong-password' })
      .expect(401);

    const noSuchUser = await request(app.getHttpServer() as Server)
      .post('/auth/login')
      .send({ username: 'ghost-user-not-exists', password: 'wrong-password' })
      .expect(401);

    // 防用户名枚举的可观察面：两条路径的错误码与文案必须逐字相同。
    // 只断言「都是 401」是不够的——分叉出「用户不存在」与「密码错误」两个码
    // 依然会让扫描器拿到一张用户名清单。
    // traceId 是每次请求唯一的，比较时排除它。
    const { traceId: _wt, ...wrongRest } = wrongPassword.body as Record<
      string,
      unknown
    >;
    const { traceId: _nt, ...noSuchRest } = noSuchUser.body as Record<
      string,
      unknown
    >;
    expect(wrongRest).toEqual(noSuchRest);
    expect((wrongPassword.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.AUTH_CREDENTIALS_INVALID,
    );
  });

  it('停用账号 + 正确密码 → 20102（R18：口令先于停用判定）', async () => {
    const disabled = await seedUser(prisma, {
      username: 'lisi',
      deptId: normalDeptId,
      status: 0,
    });

    const response = await request(app.getHttpServer() as Server)
      .post('/auth/login')
      .send({ username: disabled.username, password: disabled.password })
      .expect(401);

    const body = response.body as ResponseEnvelope<null>;

    expect(body.code).toBe(ErrorCode.AUTH_ACCOUNT_DISABLED);
  });

  it('停用账号 + 错误密码 → 20101（不得泄露「账号存在」）', async () => {
    const response = await request(app.getHttpServer() as Server)
      .post('/auth/login')
      .send({ username: 'lisi', password: 'not-the-password' })
      .expect(401);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.AUTH_CREDENTIALS_INVALID,
    );
  });

  it('连续失败达到阈值即锁定，锁定期内正确密码也进不去', async () => {
    const target = await seedUser(prisma, {
      username: 'wangwu',
      deptId: normalDeptId,
    });

    let lastCode = 0;
    for (let attempt = 1; attempt <= LOGIN_MAX_ATTEMPTS; attempt += 1) {
      const response = await request(app.getHttpServer() as Server)
        .post('/auth/login')
        .send({ username: target.username, password: 'wrong-password' })
        .expect(401);
      lastCode = (response.body as ResponseEnvelope<null>).code;
    }

    // 第 5 次（= 阈值）失败就已经进入锁定态，报的是「被锁」而不是「密码错」
    expect(lastCode).toBe(ErrorCode.AUTH_LOGIN_LOCKED);

    // 锁定期内即使口令正确也拒绝——这是「15 分钟内 5 次即锁定」的另一半
    const withCorrectPassword = await request(app.getHttpServer() as Server)
      .post('/auth/login')
      .send({ username: target.username, password: target.password })
      .expect(401);

    expect((withCorrectPassword.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.AUTH_LOGIN_LOCKED,
    );
  });

  it('带令牌访问受保护接口 → 200', async () => {
    const tokens = await loginAs(app, admin.username, admin.password);
    await authedAgent(app, tokens.accessToken).get('/depts/tree').expect(200);
  });

  it('refresh 返回新 access 与**原** refresh（不轮换）', async () => {
    const first = await loginAs(app, admin.username, admin.password);

    const response = await request(app.getHttpServer() as Server)
      .post('/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(200);

    const body = response.body as ResponseEnvelope<{
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
    }>;

    expect(body.data.accessToken).not.toBe(first.accessToken);
    expect(body.data.refreshToken).toBe(first.refreshToken); // 决策 6
    expect(body.data.expiresIn).toBe(7200);
  });

  it('refresh 递垃圾 → 401 / 20104', async () => {
    // @IsJWT 会把完全不是 JWT 的字符串挡在管道层（400），所以这里用一个
    // 结构合法但签名错误的令牌——它能过 @IsJWT，到 Service 里被 verifyRefresh 判为 invalid。
    const response = await request(app.getHttpServer() as Server)
      .post('/auth/refresh')
      .send({
        refreshToken:
          'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.invalid-signature',
      })
      .expect(401);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.AUTH_REFRESH_INVALID,
    );
  });

  it('refresh 递非 JWT 字符串 → 400 参数校验失败', async () => {
    const response = await request(app.getHttpServer() as Server)
      .post('/auth/refresh')
      .send({ refreshToken: 'not-a-jwt' })
      .expect(400);

    const body = response.body as ResponseEnvelope<{
      fields: { field: string; message: string }[];
    }>;
    expect(body.code).toBe(ErrorCode.PARAM_INVALID);
    expect(body.data.fields[0].field).toBe('refreshToken');
  });

  it('登出后 access 与 refresh 同时失效', async () => {
    const tokens = await loginAs(app, admin.username, admin.password);
    const agent = authedAgent(app, tokens.accessToken);

    await agent.get('/depts/tree').expect(200); // 先证明它是好的

    await request(app.getHttpServer() as Server)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ refreshToken: tokens.refreshToken })
      .expect(204);

    // access 进黑名单
    await agent.get('/depts/tree').expect(401);
    // refresh 出白名单
    const refreshed = await request(app.getHttpServer() as Server)
      .post('/auth/refresh')
      .send({ refreshToken: tokens.refreshToken })
      .expect(401);
    expect((refreshed.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.AUTH_REFRESH_INVALID,
    );
  });

  it('登出递别人的 refresh → 204，只拉黑自己的 access，不动别人的 refresh', async () => {
    // 两个登录会话：victim 与 attacker
    const victimTokens = await loginAs(app, admin.username, admin.password);
    const attackerTokens = await loginAs(app, normal.username, normal.password);

    // attacker 用 victim 的 refresh 登出——必须 204（不报 401，不泄露「这枚令牌是否有效」）
    await request(app.getHttpServer() as Server)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${attackerTokens.accessToken}`)
      .send({ refreshToken: victimTokens.refreshToken })
      .expect(204);

    // (a) attacker 自己的 access 已被拉黑 → 401
    await authedAgent(app, attackerTokens.accessToken)
      .get('/depts/tree')
      .expect(401);

    // (b) victim 的 refresh 仍然可用（没有被误删）
    const refreshed = await request(app.getHttpServer() as Server)
      .post('/auth/refresh')
      .send({ refreshToken: victimTokens.refreshToken })
      .expect(200);
    const refreshBody = refreshed.body as ResponseEnvelope<{
      accessToken: string;
    }>;
    expect(typeof refreshBody.data.accessToken).toBe('string');
  });

  it('普通用户（无任何权限码）访问 @RequirePermission 路由 → 403 / 10003', async () => {
    const tokens = await loginAs(app, normal.username, normal.password);

    const response = await authedAgent(app, tokens.accessToken)
      .get('/depts/tree')
      .expect(403);

    const body = response.body as ResponseEnvelope<null>;

    expect(body.code).toBe(ErrorCode.FORBIDDEN);
    expect(body.message).toContain('dept:list');
  });

  it('超管跳过全部权限检查', async () => {
    const tokens = await loginAs(app, admin.username, admin.password);
    await authedAgent(app, tokens.accessToken).get('/depts/tree').expect(200);
  });

  it('API 创建的记录，created_by 是当前登录用户（R4 兜底）', async () => {
    // 6b 收口后建记录的 HTTP 入口只剩受限建号（POST /depts 已删），
    // 这条 R4 兜底跟着挪到它上面——性质不变：守卫必须把身份写进
    // **中间件建好的** ALS store，审计字段才不是恒 0。
    const tokens = await loginAs(app, admin.username, admin.password);
    const agent = authedAgent(app, tokens.accessToken);

    const roleResponse = await agent
      .post('/roles')
      .send({ name: '审计探针角色', code: 'audit_probe_role' })
      .expect(201);
    const roleId = (roleResponse.body as ResponseEnvelope<{ id: string }>).data
      .id;

    const response = await agent
      .post('/users/account')
      .send({
        username: 'audit-probe',
        realName: '审计探针',
        employeeNo: 'AUDIT-1',
        deptId: normalDeptId.toString(),
        roleIds: [roleId],
      })
      .expect(201);

    const body = response.body as ResponseEnvelope<UserDetailResponseDto>;

    expect(body.data.createdBy).toBe(admin.userId.toString());
    expect(body.data.createdBy).not.toBe('0');
  });

  // ── Task 6 收尾：当前登录者画像 / 本人改密 ──────────────────────────

  it('GET /auth/profile 登录后 → 200；未登录 → 401 / 10002', async () => {
    const anonymous = await request(app.getHttpServer() as Server)
      .get('/auth/profile')
      .expect(401);
    expect((anonymous.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.UNAUTHORIZED,
    );

    const tokens = await loginAs(app, normal.username, normal.password);
    const response = await authedAgent(app, tokens.accessToken)
      .get('/auth/profile')
      .expect(200);

    const body = response.body as ResponseEnvelope<{
      user: { username: string; password?: string };
      permissions: unknown;
      menus: unknown;
    }>;

    expect(body.code).toBe(0);
    expect(body.data.user.username).toBe(normal.username);
    expect(Array.isArray(body.data.permissions)).toBe(true);
    expect(Array.isArray(body.data.menus)).toBe(true);
  });

  it('profile 响应不含密码（RES-05）', async () => {
    const tokens = await loginAs(app, normal.username, normal.password);
    const response = await authedAgent(app, tokens.accessToken)
      .get('/auth/profile')
      .expect(200);

    const body = response.body as ResponseEnvelope<{
      user: { password?: unknown };
    }>;

    expect(body.data.user.password).toBeUndefined();
  });

  it('超管的 permissions 不为空且走 findAllCodes（超管没挂任何角色）', async () => {
    // 种一颗启用的权限码。超管没挂角色，findCodesByUserId 会返回空——
    // 若 profile.permissions 里能看到这颗码，说明走的是 findAllCodes 全集那条路。
    await prisma.client.sysPermission.create({
      data: {
        parentId: null,
        type: 'MENU',
        code: 'user:list',
        name: '用户管理',
        path: '/system/users',
        component: 'system/user/index',
        sortOrder: 0,
        status: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });

    const tokens = await loginAs(app, admin.username, admin.password);
    const response = await authedAgent(app, tokens.accessToken)
      .get('/auth/profile')
      .expect(200);

    const body = response.body as ResponseEnvelope<{
      permissions: string[];
    }>;

    expect(body.data.permissions.length).toBeGreaterThan(0);
    expect(body.data.permissions).toContain('user:list');

    // 且 permissions 恰好等于库里全部启用的权限码（findAllCodes 的语义）
    const rows = await prisma.client.sysPermission.findMany({
      where: { code: { not: null }, deletedAt: null, status: 1 },
      select: { code: true },
    });
    const expected = rows.flatMap((row) =>
      row.code === null ? [] : [row.code],
    );
    expect([...body.data.permissions].sort()).toEqual([...expected].sort());
  });

  it('PUT /auth/password 旧密码错 → 400 / 20105，且原密码仍可登录', async () => {
    const target = await seedUser(prisma, {
      username: 'pw-wrong-old',
      deptId: normalDeptId,
    });

    const tokens = await loginAs(app, target.username, target.password);
    const response = await authedAgent(app, tokens.accessToken)
      .put('/auth/password')
      .send({ oldPassword: 'NotTheOldOne!', newPassword: 'NewPassw0rd!' })
      .expect(400);

    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.AUTH_PASSWORD_MISMATCH);

    // 原密码没被动过
    await request(app.getHttpServer() as Server)
      .post('/auth/login')
      .send({ username: target.username, password: target.password })
      .expect(200);
  });

  it('PUT /auth/password 成功 → 200，旧 access token 随后 401（R14），新密码可登录、旧密码不可', async () => {
    const target = await seedUser(prisma, {
      username: 'pw-ok',
      deptId: normalDeptId,
    });

    const tokens = await loginAs(app, target.username, target.password);
    const agent = authedAgent(app, tokens.accessToken);
    await agent.get('/auth/profile').expect(200); // 先证明这枚令牌是好的

    await agent
      .put('/auth/password')
      .send({ oldPassword: target.password, newPassword: 'NewPassw0rd!' })
      .expect(200);

    // R14：改完密码把自己也踢下线——旧 access token 随后必须 401
    const afterChange = await agent.get('/auth/profile').expect(401);
    expect((afterChange.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.UNAUTHORIZED,
    );

    // 新密码可登录
    await request(app.getHttpServer() as Server)
      .post('/auth/login')
      .send({ username: target.username, password: 'NewPassw0rd!' })
      .expect(200);

    // 旧密码不可
    await request(app.getHttpServer() as Server)
      .post('/auth/login')
      .send({ username: target.username, password: target.password })
      .expect(401);
  });

  it('PUT /auth/password 未登录 → 401 / 10002', async () => {
    const response = await request(app.getHttpServer() as Server)
      .put('/auth/password')
      .send({ oldPassword: 'Passw0rd!', newPassword: 'NewPassw0rd!' })
      .expect(401);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.UNAUTHORIZED,
    );
  });
});
