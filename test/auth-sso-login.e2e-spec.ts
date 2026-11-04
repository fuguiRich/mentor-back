/* eslint-disable @typescript-eslint/no-require-imports */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { compareSync, hashSync } from 'bcryptjs';
import request from 'supertest';
import { configureApp } from '../src/bootstrap';
import { BCRYPT_ROUNDS } from '../src/common/constants/auth.constants';
import { ErrorCode } from '../src/common/constants/error-code';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import type { AuthTokensResponseDto } from '../src/modules/auth/dto/auth-tokens.response.dto';
import { SsoUserProvisioner } from '../src/modules/sync/sso/sso-user-provisioner';
import {
  authedAgent,
  clearBusinessTables,
  clearRedisKeys,
  seedUser,
} from './e2e-helpers';

type SsoMode =
  'success' | 'credentials' | 'locked' | 'unavailable' | 'server_error';

async function clearSyncTables(prisma: PrismaService): Promise<void> {
  const tables = ['mentor_profile', 'sync_person', 'sync_org_unit', 'sync_run'];
  for (const table of tables) {
    await prisma.client.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
}

describe('SSO 登录（api-login 优先 + 本地回退）(e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let ssoServer: Server;
  let ssoBaseUrl: string;
  let rootDeptId: bigint;
  let hitCount = 0;
  const ssoMode: { kind: SsoMode } = { kind: 'success' };

  const envBackup = new Map<string, string | undefined>();
  const ENV_KEYS = [
    'SSO_LOGIN_ENABLED',
    'SSO_BASE_URL',
    'SSO_APP_ID',
    'SSO_APP_SECRET',
    'SSO_APP_SECRET_MODE',
    'SSO_RATE_LIMIT_PER_MINUTE',
    'SSO_FALLBACK_ENABLED',
    'SSO_FALLBACK_ON_5XX',
  ] as const;

  beforeAll(async () => {
    for (const key of ENV_KEYS) {
      envBackup.set(key, process.env[key]);
    }

    ssoServer = createServer((req, res) => {
      if (req.url !== '/sso/login/api-login') {
        res.statusCode = 404;
        res.end('{}');
        return;
      }
      hitCount += 1;
      res.setHeader('content-type', 'application/json');

      if (ssoMode.kind === 'unavailable') {
        req.socket.destroy();
        return;
      }
      if (ssoMode.kind === 'server_error') {
        res.statusCode = 502;
        res.end('<html>bad gateway</html>');
        return;
      }
      if (ssoMode.kind === 'credentials') {
        res.end(JSON.stringify({ code: 500, msg: '账号或密码错误' }));
        return;
      }
      if (ssoMode.kind === 'locked') {
        res.end(
          JSON.stringify({ code: 500, msg: '账号已被锁定，15分钟后再试' }),
        );
        return;
      }

      res.end(
        JSON.stringify({
          code: 200,
          user: {
            userName: 'T950',
            nickName: '教师甲',
            userType: 'teacher',
            dept: { deptId: '10', deptName: '计算机学院' },
            isDefaultPwd: false,
          },
        }),
      );
    });
    await new Promise<void>((resolve) => {
      ssoServer.listen(0, '127.0.0.1', resolve);
    });
    ssoBaseUrl = `http://127.0.0.1:${(ssoServer.address() as AddressInfo).port}`;

    process.env.SSO_LOGIN_ENABLED = '1';
    process.env.SSO_BASE_URL = ssoBaseUrl;
    process.env.SSO_APP_ID = 'app_x';
    process.env.SSO_APP_SECRET = 'secret';
    process.env.SSO_APP_SECRET_MODE = 'plain';
    process.env.SSO_RATE_LIMIT_PER_MINUTE = '1000';
    process.env.SSO_FALLBACK_ENABLED = '1';
    process.env.SSO_FALLBACK_ON_5XX = '0';

    // 必须在 require AppModule 之前设好环境变量（ConfigModule 在导入时加载）。
    // 用 require 而不是 import：ts-jest 的 CJS 环境不支持动态 import()。

    const { AppModule } =
      require('../src/app.module') as typeof import('../src/app.module');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
  });

  afterAll(async () => {
    try {
      if (app !== undefined) {
        await app.close();
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        ssoServer.close((error) => (error ? reject(error) : resolve()));
      });
      for (const key of ENV_KEYS) {
        const value = envBackup.get(key);
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  beforeEach(async () => {
    await clearBusinessTables(prisma);
    await clearSyncTables(prisma);
    await clearRedisKeys(redis);

    hitCount = 0;
    ssoMode.kind = 'success';

    const root = await prisma.client.sysDept.create({
      data: {
        parentId: null,
        name: '总公司',
        sortOrder: 0,
        status: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    rootDeptId = root.id;

    await prisma.client.sysRole.createMany({
      data: [
        {
          code: 'mentor',
          name: '导师',
          dataScope: 'self',
          status: 1,
          createdBy: 0n,
          updatedBy: 0n,
        },
        {
          code: 'student',
          name: '学生',
          dataScope: 'self',
          status: 1,
          createdBy: 0n,
          updatedBy: 0n,
        },
      ],
    });
  });

  it('SSO 成功 → 自动建号 + 回写密码/信息 + mentor 角色', async () => {
    const response = await request(app.getHttpServer() as Server)
      .post('/auth/login')
      .send({ username: 'T950', password: 'Passw0rd!' })
      .expect(200);

    const body = response.body as ResponseEnvelope<AuthTokensResponseDto>;
    expect(body.data.loginSource).toBe('sso');
    expect(body.data.ssoUnavailable).toBe(false);
    expect(body.data.isDefaultPwd).toBe(false);

    const user = await prisma.client.sysUser.findFirst({
      where: { username: 'T950' },
    });
    expect(user).toMatchObject({
      employeeNo: 'T950',
      realName: '教师甲',
      authSource: 'sso',
      status: 1,
    });
    expect(user?.deptId).not.toBe(rootDeptId);
    expect(compareSync('Passw0rd!', user?.password ?? '')).toBe(true);

    const person = await prisma.client.syncPerson.findFirst({
      where: { login: 'T950' },
    });
    expect(person?.personType).toBe('teacher');

    const mentorRole = await prisma.client.sysRole.findFirst({
      where: { code: 'mentor' },
    });
    const bound = await prisma.client.sysUserRole.findFirst({
      where: { userId: user?.id, roleId: mentorRole?.id },
    });
    expect(bound).not.toBeNull();
  });

  it('SSO 账号 PUT /auth/password → 403 / 20112', async () => {
    const login = await request(app.getHttpServer() as Server)
      .post('/auth/login')
      .send({ username: 'T950', password: 'Passw0rd!' })
      .expect(200);
    const token = (login.body as ResponseEnvelope<AuthTokensResponseDto>).data
      .accessToken;

    const response = await authedAgent(app, token)
      .put('/auth/password')
      .send({ oldPassword: 'Passw0rd!', newPassword: 'NewPassw0rd!' })
      .expect(403);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.AUTH_SSO_PASSWORD_MANAGED,
    );
  });

  it('GET /auth/profile 返回 authSource=sso', async () => {
    const login = await request(app.getHttpServer() as Server)
      .post('/auth/login')
      .send({ username: 'T950', password: 'Passw0rd!' })
      .expect(200);
    const token = (login.body as ResponseEnvelope<AuthTokensResponseDto>).data
      .accessToken;

    const profile = await authedAgent(app, token)
      .get('/auth/profile')
      .expect(200);

    expect(
      (profile.body as ResponseEnvelope<{ user: { authSource: string } }>).data
        .user.authSource,
    ).toBe('sso');
  });

  it('已有 SSO 账号但缺角色/SyncPerson → 登录时补齐', async () => {
    await seedUser(prisma, {
      username: 'T950',
      password: 'Passw0rd!',
      authSource: 'sso',
      deptId: rootDeptId,
    });

    await request(app.getHttpServer() as Server)
      .post('/auth/login')
      .send({ username: 'T950', password: 'Passw0rd!' })
      .expect(200);

    const user = await prisma.client.sysUser.findFirst({
      where: { username: 'T950' },
    });
    const mentorRole = await prisma.client.sysRole.findFirst({
      where: { code: 'mentor' },
    });
    expect(
      await prisma.client.sysUserRole.findFirst({
        where: { userId: user?.id, roleId: mentorRole?.id },
      }),
    ).not.toBeNull();
    expect(
      await prisma.client.syncPerson.findFirst({ where: { login: 'T950' } }),
    ).not.toBeNull();
  });

  it('SSO 密码错误 → 401 / 20101，不回退、不建号', async () => {
    ssoMode.kind = 'credentials';

    const response = await request(app.getHttpServer() as Server)
      .post('/auth/login')
      .send({ username: 'T950', password: 'wrong-pass' })
      .expect(401);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.AUTH_CREDENTIALS_INVALID,
    );
    expect(
      await prisma.client.sysUser.count({ where: { username: 'T950' } }),
    ).toBe(0);
  });

  it('SSO 锁定 → 401 / 20103', async () => {
    ssoMode.kind = 'locked';

    const response = await request(app.getHttpServer() as Server)
      .post('/auth/login')
      .send({ username: 'T950', password: 'Passw0rd!' })
      .expect(401);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.AUTH_LOGIN_LOCKED,
    );
  });

  it('SSO 不可达 + 本地密码正确 → 200 / local-fallback', async () => {
    await seedUser(prisma, {
      username: 'T951',
      password: 'Passw0rd!',
      authSource: 'sso',
      deptId: rootDeptId,
    });
    ssoMode.kind = 'unavailable';

    const response = await request(app.getHttpServer() as Server)
      .post('/auth/login')
      .send({ username: 'T951', password: 'Passw0rd!' })
      .expect(200);

    const body = response.body as ResponseEnvelope<AuthTokensResponseDto>;
    expect(body.data.loginSource).toBe('local-fallback');
    expect(body.data.ssoUnavailable).toBe(true);
  });

  it('SSO 不可达 + 本地密码错误 → 401 / 20101', async () => {
    await seedUser(prisma, {
      username: 'T951',
      password: 'Passw0rd!',
      authSource: 'sso',
      deptId: rootDeptId,
    });
    ssoMode.kind = 'unavailable';

    const response = await request(app.getHttpServer() as Server)
      .post('/auth/login')
      .send({ username: 'T951', password: 'wrong-pass' })
      .expect(401);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.AUTH_CREDENTIALS_INVALID,
    );
  });

  it('SSO 5xx 且 fallbackOn5xx=false → 503 / 20108，不回退', async () => {
    await seedUser(prisma, {
      username: 'T951',
      password: 'Passw0rd!',
      authSource: 'sso',
      deptId: rootDeptId,
    });
    ssoMode.kind = 'server_error';

    const response = await request(app.getHttpServer() as Server)
      .post('/auth/login')
      .send({ username: 'T951', password: 'Passw0rd!' })
      .expect(503);

    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.AUTH_SSO_UNAVAILABLE,
    );
  });

  it('本地管理员（authSource=local）→ 不调 SSO，loginSource=local', async () => {
    await seedUser(prisma, {
      username: 'localadmin',
      password: 'Passw0rd!',
      authSource: 'local',
      deptId: rootDeptId,
      isSuperAdmin: true,
    });

    const response = await request(app.getHttpServer() as Server)
      .post('/auth/login')
      .send({ username: 'localadmin', password: 'Passw0rd!' })
      .expect(200);

    const body = response.body as ResponseEnvelope<AuthTokensResponseDto>;
    expect(body.data.loginSource).toBe('local');
    expect(hitCount).toBe(0);
  });

  it('自动建号：provisioner 直接调用也幂等', async () => {
    const provisioner = app.get(SsoUserProvisioner);
    const first = await provisioner.ensureUser({
      login: 'T901',
      realName: '教师乙',
      userType: 'teacher',
      deptId: null,
      deptName: null,
      passwordHash: hashSync('x', BCRYPT_ROUNDS),
    });
    const second = await provisioner.ensureUser({
      login: 'T901',
      realName: '教师乙',
      userType: 'teacher',
      deptId: null,
      deptName: null,
      passwordHash: hashSync('x', BCRYPT_ROUNDS),
    });

    expect(second.userId).toBe(first.userId);
    expect(
      await prisma.client.sysUser.count({ where: { username: 'T901' } }),
    ).toBe(1);
    expect(
      await prisma.client.syncPerson.count({ where: { login: 'T901' } }),
    ).toBe(1);
  });
});
