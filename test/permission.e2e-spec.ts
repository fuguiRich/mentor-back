import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'node:http';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { PermissionRepository } from '../src/modules/permission/permission.repository';
import { ErrorCode } from '../src/common/constants/error-code';
import { redisKeys } from '../src/infra/redis/redis-keys';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import type { PermissionResponseDto } from '../src/modules/permission/dto/permission-response.dto';
import type { PermissionTreeResponseDto } from '../src/modules/permission/dto/permission-tree-response.dto';
import {
  authedAgent,
  clearRedisKeys,
  clearBusinessTables,
  loginAs,
  seedSuperAdmin,
  seedUser,
  type E2eApi,
} from './e2e-helpers';

function findNode(
  nodes: PermissionTreeResponseDto[],
  id: string,
): PermissionTreeResponseDto | undefined {
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }
    const hit = findNode(node.children, id);
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}

describe('权限点 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let api: E2eApi;

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

  it('1. 未登录 GET /permissions/tree → 401 / 10002', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/permissions/tree')
      .expect(401);

    const body = response.body as ResponseEnvelope<null>;

    expect(body.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(body.data).toBeNull();
  });

  it('2. 无权限的普通用户 → 403 / 10003，消息含 permission:list', async () => {
    const root = await prisma.client.sysDept.findFirst({
      where: { name: '总公司' },
    });
    if (root === null) {
      throw new Error('seedSuperAdmin 未种出「总公司」部门');
    }
    const normal = await seedUser(prisma, {
      username: 'perm-user',
      deptId: root.id,
    });
    const tokens = await loginAs(app, normal.username, normal.password);

    const response = await authedAgent(app, tokens.accessToken)
      .get('/permissions/tree')
      .expect(403);

    const body = response.body as ResponseEnvelope<null>;

    expect(body.code).toBe(ErrorCode.FORBIDDEN);
    expect(body.message).toContain('permission:list');
  });

  it('3. 树返回组装好的结构（父 DIR + 子 MENU）', async () => {
    const parent = await api
      .post('/permissions')
      .send({
        type: 'DIR',
        name: '系统管理',
        icon: 'setting',
        sortOrder: 1,
      })
      .expect(201);
    const parentBody = parent.body as ResponseEnvelope<PermissionResponseDto>;

    const child = await api
      .post('/permissions')
      .send({
        parentId: parentBody.data.id,
        type: 'MENU',
        code: 'perm:tree-menu',
        name: '权限点管理',
        path: '/system/permissions',
        component: 'system/permission/index',
        icon: 'tree',
        sortOrder: 2,
      })
      .expect(201);
    const childBody = child.body as ResponseEnvelope<PermissionResponseDto>;

    const response = await api.get('/permissions/tree').expect(200);
    const body = response.body as ResponseEnvelope<PermissionTreeResponseDto[]>;

    expect(body.code).toBe(0);

    const parentNode = findNode(body.data, parentBody.data.id);
    expect(parentNode).toMatchObject({
      id: parentBody.data.id,
      parentId: null,
      type: 'DIR',
      code: null,
      name: '系统管理',
      icon: 'setting',
      sortOrder: 1,
      status: 1,
    });

    const childNode = findNode(body.data, childBody.data.id);
    expect(childNode).toMatchObject({
      id: childBody.data.id,
      parentId: parentBody.data.id,
      type: 'MENU',
      code: 'perm:tree-menu',
      name: '权限点管理',
      path: '/system/permissions',
      component: 'system/permission/index',
      icon: 'tree',
      sortOrder: 2,
      status: 1,
    });
    expect(parentNode?.children.map((node) => node.id)).toContain(
      childBody.data.id,
    );
  });

  it('4. create DIR 不带 code → 201', async () => {
    const response = await api
      .post('/permissions')
      .send({ type: 'DIR', name: '无码目录' })
      .expect(201);

    const body = response.body as ResponseEnvelope<PermissionResponseDto>;

    expect(body.data).toMatchObject({
      type: 'DIR',
      code: null,
      name: '无码目录',
    });
  });

  it('5. create MENU 不带 code → 400 / 23103', async () => {
    const response = await api
      .post('/permissions')
      .send({ type: 'MENU', name: '缺码菜单' })
      .expect(400);

    const body = response.body as ResponseEnvelope<null>;

    expect(body.code).toBe(ErrorCode.PERMISSION_CODE_REQUIRED);
  });

  it('6. create DIR 带 code → 400 / 23104', async () => {
    const response = await api
      .post('/permissions')
      .send({ type: 'DIR', code: 'user:list', name: '带码目录' })
      .expect(400);

    const body = response.body as ResponseEnvelope<null>;

    expect(body.code).toBe(ErrorCode.PERMISSION_CODE_FORBIDDEN);
  });

  it('7. create BUTTON 带 code → 201', async () => {
    const response = await api
      .post('/permissions')
      .send({ type: 'BUTTON', code: 'perm:btn-create', name: '新建按钮' })
      .expect(201);

    const body = response.body as ResponseEnvelope<PermissionResponseDto>;

    expect(body.data).toMatchObject({
      type: 'BUTTON',
      code: 'perm:btn-create',
    });
  });

  it('8. create 重复 code → 409 / 23102', async () => {
    const response = await api
      .post('/permissions')
      .send({ type: 'BUTTON', code: 'perm:btn-create', name: '重复码按钮' })
      .expect(409);

    const body = response.body as ResponseEnvelope<null>;

    expect(body.code).toBe(ErrorCode.PERMISSION_CODE_TAKEN);
  });

  it('9. create 父节点不存在 → 404 / 23101', async () => {
    const response = await api
      .post('/permissions')
      .send({
        parentId: '999999',
        type: 'MENU',
        code: 'perm:orphan',
        name: '孤儿菜单',
      })
      .expect(404);

    const body = response.body as ResponseEnvelope<null>;

    expect(body.code).toBe(ErrorCode.PERMISSION_NOT_FOUND);
  });

  it('10. create code 格式非法（User List）→ 400 / 10001', async () => {
    const response = await api
      .post('/permissions')
      .send({ type: 'MENU', code: 'User List', name: '非法码菜单' })
      .expect(400);

    const body = response.body as ResponseEnvelope<null>;

    expect(body.code).toBe(ErrorCode.PARAM_INVALID);
  });

  it('11. update 只改 type 为 DIR、不传 code → 400 / 23104', async () => {
    const created = await api
      .post('/permissions')
      .send({ type: 'MENU', code: 'perm:to-dir', name: '待转目录' })
      .expect(201);
    const createdBody = created.body as ResponseEnvelope<PermissionResponseDto>;

    const response = await api
      .put(`/permissions/${createdBody.data.id}`)
      .send({ name: '待转目录', type: 'DIR' })
      .expect(400);

    const body = response.body as ResponseEnvelope<null>;

    expect(body.code).toBe(ErrorCode.PERMISSION_CODE_FORBIDDEN);
  });

  it('12. update type: DIR + code: null → 200，code 为 null', async () => {
    const created = await api
      .post('/permissions')
      .send({ type: 'MENU', code: 'perm:to-dir2', name: '转目录成功' })
      .expect(201);
    const createdBody = created.body as ResponseEnvelope<PermissionResponseDto>;

    const response = await api
      .put(`/permissions/${createdBody.data.id}`)
      .send({ name: '转目录成功', type: 'DIR', code: null })
      .expect(200);

    const body = response.body as ResponseEnvelope<PermissionResponseDto>;

    expect(body.data).toMatchObject({
      id: createdBody.data.id,
      type: 'DIR',
      code: null,
    });
  });

  it('13. update type 为 MENU 且库里无码 → 400 / 23103', async () => {
    const created = await api
      .post('/permissions')
      .send({ type: 'DIR', name: '待转菜单' })
      .expect(201);
    const createdBody = created.body as ResponseEnvelope<PermissionResponseDto>;

    const response = await api
      .put(`/permissions/${createdBody.data.id}`)
      .send({ name: '待转菜单', type: 'MENU' })
      .expect(400);

    const body = response.body as ResponseEnvelope<null>;

    expect(body.code).toBe(ErrorCode.PERMISSION_CODE_REQUIRED);
  });

  it('14. update parentId 指向自己或自己的下级 → 400 / 23105', async () => {
    const parent = await api
      .post('/permissions')
      .send({ type: 'DIR', name: '环检父目录' })
      .expect(201);
    const parentBody = parent.body as ResponseEnvelope<PermissionResponseDto>;

    const child = await api
      .post('/permissions')
      .send({
        parentId: parentBody.data.id,
        type: 'MENU',
        code: 'perm:cycle-child',
        name: '环检子菜单',
      })
      .expect(201);
    const childBody = child.body as ResponseEnvelope<PermissionResponseDto>;

    const selfResponse = await api
      .put(`/permissions/${parentBody.data.id}`)
      .send({ name: '环检父目录', parentId: parentBody.data.id })
      .expect(400);
    expect((selfResponse.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PERMISSION_PARENT_INVALID,
    );

    const descendantResponse = await api
      .put(`/permissions/${parentBody.data.id}`)
      .send({ name: '环检父目录', parentId: childBody.data.id })
      .expect(400);
    expect((descendantResponse.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PERMISSION_PARENT_INVALID,
    );
  });

  it('15. update sortOrder: null → 400 / 10001', async () => {
    const created = await api
      .post('/permissions')
      .send({ type: 'DIR', name: '空排序测试' })
      .expect(201);
    const createdBody = created.body as ResponseEnvelope<PermissionResponseDto>;

    const response = await api
      .put(`/permissions/${createdBody.data.id}`)
      .send({ name: '空排序测试', sortOrder: null })
      .expect(400);

    const body = response.body as ResponseEnvelope<null>;

    expect(body.code).toBe(ErrorCode.PARAM_INVALID);
  });

  it('16. delete 叶子 → 204，GET tree 里消失，GET :id → 404', async () => {
    const created = await api
      .post('/permissions')
      .send({ type: 'MENU', code: 'perm:leaf', name: '待删叶子' })
      .expect(201);
    const createdBody = created.body as ResponseEnvelope<PermissionResponseDto>;

    await api.delete(`/permissions/${createdBody.data.id}`).expect(204);

    const tree = await api.get('/permissions/tree').expect(200);
    const treeBody = tree.body as ResponseEnvelope<PermissionTreeResponseDto[]>;
    expect(findNode(treeBody.data, createdBody.data.id)).toBeUndefined();

    const detail = await api.get(`/permissions/${createdBody.data.id}`);
    expect(detail.status).toBe(404);
    expect((detail.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PERMISSION_NOT_FOUND,
    );
  });

  it('17. delete 带下级 → 409 / 23106', async () => {
    const parent = await api
      .post('/permissions')
      .send({ type: 'DIR', name: '带下级目录' })
      .expect(201);
    const parentBody = parent.body as ResponseEnvelope<PermissionResponseDto>;

    await api
      .post('/permissions')
      .send({
        parentId: parentBody.data.id,
        type: 'MENU',
        code: 'perm:kept-child',
        name: '保留子菜单',
      })
      .expect(201);

    const response = await api
      .delete(`/permissions/${parentBody.data.id}`)
      .expect(409);

    const body = response.body as ResponseEnvelope<null>;

    expect(body.code).toBe(ErrorCode.PERMISSION_HAS_CHILDREN);
  });

  it('18. delete 清连接行 + 清权限缓存', async () => {
    const root = await prisma.client.sysDept.findFirst({
      where: { name: '总公司' },
    });
    if (root === null) {
      throw new Error('seedSuperAdmin 未种出「总公司」部门');
    }
    const holder = await seedUser(prisma, {
      username: 'perm-holder',
      deptId: root.id,
    });

    const role = await prisma.client.sysRole.create({
      data: {
        name: '缓存清理探针角色',
        code: `probe-cache-${Date.now().toString()}`,
        status: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    await prisma.client.sysUserRole.create({
      data: {
        userId: holder.userId,
        roleId: role.id,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });

    const created = await api
      .post('/permissions')
      .send({ type: 'BUTTON', code: 'perm:cache-probe', name: '缓存探针' })
      .expect(201);
    const createdBody = created.body as ResponseEnvelope<PermissionResponseDto>;
    const permissionId = BigInt(createdBody.data.id);

    await prisma.client.sysRolePermission.create({
      data: {
        roleId: role.id,
        permissionId,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });

    const cacheKey = redisKeys.auth.permissions(holder.userId);
    await redis.client.set(cacheKey, JSON.stringify(['perm:cache-probe']));

    await api.delete(`/permissions/${createdBody.data.id}`).expect(204);

    const refCount = await prisma.client.sysRolePermission.count({
      where: { permissionId },
    });
    expect(refCount).toBe(0);

    const cached = await redis.client.get(cacheKey);
    expect(cached).toBeNull();
  });

  it('19. 回滚金丝雀（R24）：repository 软删除跟着事务回滚、扩展拒绝 delete、includingDeleted 仍可物理删', async () => {
    const created = await prisma.client.sysPermission.create({
      data: {
        parentId: null,
        type: 'MENU',
        code: `probe:rollback${Date.now().toString()}`,
        name: '回滚探针',
        sortOrder: 0,
        status: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });

    // (a) repository 的软删除路径跑在一个会回滚的事务里 ⇒ 行原样留着。
    // 这条守的正是 R19 金丝雀的原性质：软删除的写入必须留在事务内。
    // 壳只替换 $transaction：把 deleteWithRoleRefs 自己的写序列接到外层事务上，
    // 跑完后主动抛错触发回滚。若软删除逃出事务（R19 时期的 bug），标记会落库、
    // deletedAt 不再是 null，这里当场红；若 deleteWithRoleRefs 又改回 delete()，
    // 扩展的拒绝会先抛出来、消息不是「故意回滚」，同样当场红。
    const repo = new PermissionRepository({
      client: {
        $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
          prisma.client.$transaction(async (tx) => {
            await fn(tx);
            throw new Error('故意回滚');
          }),
      },
    } as unknown as PrismaService);

    await expect(repo.deleteWithRoleRefs(created.id)).rejects.toThrow(
      '故意回滚',
    );

    const stillThere = await prisma.client.sysPermission.findFirst({
      where: { id: created.id },
    });
    expect(stillThere).not.toBeNull();
    expect(stillThere?.deletedAt).toBeNull();

    // (b) 扩展对实体表的 delete 直接拒绝——「不小心硬删实体行」必须是响亮的失败
    await expect(
      prisma.client.sysPermission.delete({ where: { id: created.id } }),
    ).rejects.toThrow(/includingDeleted/);

    // (c) includingDeleted 是唯一合法的物理删除通道（purge 走它），不被 (b) 挡住
    await prisma.includingDeleted.sysPermission.delete({
      where: { id: created.id },
    });
    const purged = await prisma.includingDeleted.sysPermission.findFirst({
      where: { id: created.id },
    });
    expect(purged).toBeNull();
  });

  // ── 6b 收口后的权限点覆盖：每个存活入口的 403 都点名自己的码 ─────────────
  describe('收口后的权限点覆盖（6b）', () => {
    let normal: { userId: bigint; username: string; password: string };
    let targetId: string;

    beforeAll(async () => {
      const root = await prisma.client.sysDept.findFirst({
        where: { name: '总公司' },
      });
      if (root === null) {
        throw new Error('seedSuperAdmin 未种出「总公司」部门');
      }
      normal = await seedUser(prisma, {
        username: 'perm-coverage-user',
        deptId: root.id,
      });
      targetId = normal.userId.toString();
    });

    it('6 个权限码 / 7 个入口对无码用户 → 403 / 10003，消息点名各自的码', async () => {
      const tokens = await loginAs(app, normal.username, normal.password);
      const guard = authedAgent(app, tokens.accessToken);

      const cases: Array<{ code: string; call: () => Promise<unknown> }> = [
        { code: 'user:list', call: () => guard.get('/users').expect(403) },
        {
          code: 'user:create',
          call: () => guard.post('/users/account').send({}).expect(403),
        },
        {
          code: 'user:update',
          call: () =>
            guard
              .put(`/users/${targetId}/status`)
              .send({ status: 0 })
              .expect(403),
        },
        {
          code: 'user:reset-password',
          call: () =>
            guard
              .put(`/users/${targetId}/password`)
              .send({ password: 'Whatever1!' })
              .expect(403),
        },
        {
          code: 'user:assign-role',
          call: () =>
            guard
              .put(`/users/${targetId}/roles`)
              .send({ roleIds: [] })
              .expect(403),
        },
        { code: 'dept:list', call: () => guard.get('/depts/tree').expect(403) },
        {
          code: 'dept:list',
          call: () => guard.get(`/depts/${targetId}`).expect(403),
        },
      ];

      for (const { code, call } of cases) {
        const response = (await call()) as { body: ResponseEnvelope<null> };
        expect(response.body.code).toBe(ErrorCode.FORBIDDEN);
        expect(response.body.message).toContain(code);
      }
    });

    it('判据 1 的对照面：删掉的 7 条路由对无码用户是 404 而不是 403（RequirePermission 那层也没了）', async () => {
      // 路由若还在，这个用户会先被权限挡下拿 403——拿到 404 只可能因为路由没了。
      const tokens = await loginAs(app, normal.username, normal.password);
      const guard = authedAgent(app, tokens.accessToken);

      const deletedCalls: Array<() => Promise<unknown>> = [
        () => guard.post('/users').send({}).expect(404),
        () => guard.put(`/users/${targetId}`).send({}).expect(404),
        () => guard.delete(`/users/${targetId}`).expect(404),
        () => guard.delete(`/users/${targetId}/purge`).expect(404),
        () => guard.post('/depts').send({}).expect(404),
        () => guard.put(`/depts/${targetId}`).send({}).expect(404),
        () => guard.delete(`/depts/${targetId}`).expect(404),
      ];
      for (const call of deletedCalls) {
        await call();
      }
    });
  });
});
