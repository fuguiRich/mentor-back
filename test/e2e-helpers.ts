import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { hashSync } from 'bcryptjs';
import request from 'supertest';
import { BCRYPT_ROUNDS } from '../src/common/constants/auth.constants';
import { redisKeys } from '../src/infra/redis/redis-keys';
import type { RedisService } from '../src/infra/redis/redis.service';
import type { PrismaService } from '../src/infra/prisma/prisma.service';
import type { AuthTokensResponseDto } from '../src/modules/auth/dto/auth-tokens.response.dto';

export interface SeededUser {
  userId: bigint;
  username: string;
  password: string;
}

export type E2eApi = ReturnType<typeof request.agent>;

/**
 * 按外键拓扑序清空六张业务表。
 *
 * 两个讲究（搬自 dept.e2e-spec.ts 的原注释，它现在是五个套件共用的了）：
 * 一是实体表必须走 includingDeleted——走 client 的话 delete 会被扩展直接拒绝
 * （R24：软删除写在 repository 里，扩展不再代改写），清表要的是物理删除；
 * 二是顺序必须从引用方到被引用方，外键不认识软删除。
 */
export async function clearBusinessTables(
  prisma: PrismaService,
): Promise<void> {
  await prisma.client.sysUserRole.deleteMany({});
  await prisma.client.sysRolePermission.deleteMany({});
  await prisma.includingDeleted.sysUser.deleteMany({});
  await prisma.includingDeleted.sysRole.deleteMany({});
  await prisma.includingDeleted.sysPermission.deleteMany({});
  await prisma.includingDeleted.sysDept.deleteMany({});
}

/**
 * 清掉字典 / 配置 / 文件 / 操作日志四张表，按外键拓扑序。
 *
 * 操作日志必须走**裸 SQL**：`prisma.extension.ts` 把 SysOpLog 列进
 * APPEND_ONLY_MODELS，在 `softDelete` 分支之前就拒掉 update / delete——
 * `includingDeleted` 也过不去（那是刻意的：留痕表不给任何 Prisma 路径删改）。
 * 测试清库是运维动作，不是业务删改，所以绕开扩展直接发 DELETE。
 */
export async function clearModuleTables(prisma: PrismaService): Promise<void> {
  await prisma.includingDeleted.sysDictItem.deleteMany({});
  await prisma.includingDeleted.sysDictType.deleteMany({});
  await prisma.includingDeleted.sysConfig.deleteMany({});
  await prisma.includingDeleted.sysFile.deleteMany({});
  await prisma.client.$executeRawUnsafe('DELETE FROM sys_op_log');
}

/**
 * 清掉本系统写进 Redis 的全部键（auth:* 与 rl:*）。
 * 不用 FLUSHDB：测试用的 Redis 实例可能还被别的服务用着，
 * 清掉别人的键会变成「我的测试绿了、隔壁服务开始报错」。
 *
 * 限流桶必须一起清：它是**按人按端点**累计的计数器，上一套件留下的桶
 * 既可能把这一套件的真实请求顶成 429，也会让「扫出唯一一个桶」这类断言
 * 直接失效（e2e 是 maxWorkers:1 串行跑的，键就是会一路留到下一套件）。
 */
export async function clearRedisKeys(redis: RedisService): Promise<void> {
  const prefixes = [redisKeys.authPrefix, redisKeys.rateLimitPrefix];
  for (const prefix of prefixes) {
    const keys = await redis.client.keys(`${prefix}*`);
    if (keys.length > 0) {
      await redis.client.del(...keys);
    }
  }
}

/** 种一个部门（供用户挂靠）+ 超管账号，返回登录要用的用户名密码 */
export async function seedSuperAdmin(
  prisma: PrismaService,
): Promise<SeededUser> {
  const dept = await prisma.client.sysDept.create({
    data: {
      parentId: null,
      name: '总公司',
      sortOrder: 0,
      status: 1,
      createdBy: 0n,
      updatedBy: 0n,
    },
  });

  const password = 'Passw0rd!';
  const user = await prisma.client.sysUser.create({
    data: {
      username: 'admin',
      password: hashSync(password, BCRYPT_ROUNDS),
      realName: '超级管理员',
      employeeNo: 'admin',
      deptId: dept.id,
      status: 1,
      isSuperAdmin: true,
      createdBy: 0n,
      updatedBy: 0n,
    },
  });

  return { userId: user.id, username: 'admin', password };
}

/** 种一个普通用户（默认非超管、启用），挂在给定部门下 */
export async function seedUser(
  prisma: PrismaService,
  options: {
    username: string;
    password?: string;
    realName?: string;
    employeeNo?: string;
    deptId: bigint;
    isSuperAdmin?: boolean;
    status?: number;
  },
): Promise<SeededUser> {
  const password = options.password ?? 'Passw0rd!';
  const user = await prisma.client.sysUser.create({
    data: {
      username: options.username,
      password: hashSync(password, BCRYPT_ROUNDS),
      realName: options.realName ?? options.username,
      employeeNo: options.employeeNo ?? options.username,
      deptId: options.deptId,
      status: options.status ?? 1,
      isSuperAdmin: options.isSuperAdmin ?? false,
      createdBy: 0n,
      updatedBy: 0n,
    },
  });

  return { userId: user.id, username: options.username, password };
}

/** 登录取双令牌。**预期登录失败**时不要用它，直接自己 post /auth/login 断言错误体 */
export async function loginAs(
  app: INestApplication,
  username: string,
  password: string,
): Promise<AuthTokensResponseDto> {
  const response = await request(app.getHttpServer() as Server)
    .post('/auth/login')
    .send({ username, password })
    .expect(200);

  // ResponseInterceptor 会把 data 包在 {code,message,data} 里，这里必须先解一层外壳。
  // 不解的话 loginAs(...) 返回的 .accessToken 是 undefined，后面所有带令牌的请求都会 401，
  // 而错误信息只说「未认证」——排起来很绕。
  const body = response.body as { data: AuthTokensResponseDto };
  return body.data;
}

/**
 * 带令牌的请求代理。所有后续请求自动带 Authorization 头。
 *
 * 用 supertest 的 agent 而不是在每个调用点写 .set(...)：agent 会把默认头
 * 应用到它发出的**每一个**请求上（agent-base 的 _setDefaults），
 * 少带一次令牌的用例就多一处「是不是漏了登录」的分叉。
 */
export function authedAgent(
  app: INestApplication,
  accessToken: string,
): E2eApi {
  return request
    .agent(app.getHttpServer() as Server)
    .set('Authorization', `Bearer ${accessToken}`);
}
