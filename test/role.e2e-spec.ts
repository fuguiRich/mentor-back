import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'node:http';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { ErrorCode } from '../src/common/constants/error-code';
import { redisKeys } from '../src/infra/redis/redis-keys';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import type { PermissionResponseDto } from '../src/modules/permission/dto/permission-response.dto';
import type { RoleResponseDto } from '../src/modules/role/dto/role-response.dto';
import type { RoleDetailResponseDto } from '../src/modules/role/dto/role-detail-response.dto';
import type { RolePageResponseDto } from '../src/modules/role/dto/role-page-response.dto';
import {
  authedAgent,
  clearRedisKeys,
  clearBusinessTables,
  loginAs,
  seedSuperAdmin,
  seedUser,
  type E2eApi,
  type SeededUser,
} from './e2e-helpers';

describe('角色 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let api: E2eApi;

  /** 权限点 A / B / C（用例 9-13、15、17 的分配目标） */
  let permA: string;
  let permB: string;
  let permC: string;

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

    // 种子：权限点 A/B/C 用 API 建（permission:create，超管直通）。
    // 用户与 sys_user_role 行用 Prisma 直接种——Task 5 之前没有分配接口。
    const codes = ['probe:a', 'probe:b', 'probe:c'];
    const created: string[] = [];
    for (const code of codes) {
      const response = await api
        .post('/permissions')
        .send({ type: 'BUTTON', code, name: `探针权限 ${code}` })
        .expect(201);
      created.push(
        (response.body as ResponseEnvelope<PermissionResponseDto>).data.id,
      );
    }
    [permA, permB, permC] = created;
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

  async function createRole(
    name: string,
    code: string,
    status = 1,
  ): Promise<RoleResponseDto> {
    const response = await api
      .post('/roles')
      .send({ name, code, status })
      .expect(201);
    return (response.body as ResponseEnvelope<RoleResponseDto>).data;
  }

  /** 种一个持有者用户（挂在「总公司」下），不带角色——角色行由用例自己连 */
  async function seedHolder(username: string): Promise<SeededUser> {
    const root = await prisma.client.sysDept.findFirst({
      where: { name: '总公司' },
    });
    if (root === null) {
      throw new Error('seedSuperAdmin 未种出「总公司」部门');
    }
    return seedUser(prisma, { username, deptId: root.id });
  }

  async function linkUserRole(userId: bigint, roleId: bigint): Promise<void> {
    await prisma.client.sysUserRole.create({
      data: { userId, roleId, createdBy: 0n, updatedBy: 0n },
    });
  }

  it('1. 未登录 GET /roles → 401 / 10002；无 role:list 的普通用户 → 403 / 10003', async () => {
    const anonymous = await request(app.getHttpServer() as Server)
      .get('/roles')
      .expect(401);
    const anonymousBody = anonymous.body as ResponseEnvelope<null>;
    expect(anonymousBody.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(anonymousBody.data).toBeNull();

    const normal = await seedHolder('role-user-none');
    const tokens = await loginAs(app, normal.username, normal.password);
    const forbidden = await authedAgent(app, tokens.accessToken)
      .get('/roles')
      .expect(403);
    const forbiddenBody = forbidden.body as ResponseEnvelope<null>;
    expect(forbiddenBody.code).toBe(ErrorCode.FORBIDDEN);
    expect(forbiddenBody.message).toContain('role:list');
  });

  it('2. 分页结构：3 个角色、page=1&pageSize=2 → list 长度 2、total 3', async () => {
    await createRole('分页角色甲', 'page_role_a');
    await createRole('分页角色乙', 'page_role_b');
    await createRole('分页角色丙', 'page_role_c');

    const response = await api.get('/roles?page=1&pageSize=2').expect(200);
    const body = response.body as ResponseEnvelope<RolePageResponseDto>;

    expect(body.code).toBe(0);
    expect(body.data.list).toHaveLength(2);
    expect(body.data.total).toBe(3);
    expect(body.data.page).toBe(1);
    expect(body.data.pageSize).toBe(2);
  });

  it('3. 默认值：不传分页参数 → page: 1, pageSize: 20', async () => {
    const response = await api.get('/roles').expect(200);
    const body = response.body as ResponseEnvelope<RolePageResponseDto>;

    expect(body.data.page).toBe(1);
    expect(body.data.pageSize).toBe(20);
  });

  it('4. 筛选：name=管理 只回名字含「管理」的；status=0 只回停用的', async () => {
    await createRole('管理员甲', 'filter_admin_1', 1);
    await createRole('管理员乙', 'filter_admin_2', 0);
    await createRole('访客', 'filter_guest', 1);

    const byName = await api.get('/roles?name=管理').expect(200);
    const byNameBody = byName.body as ResponseEnvelope<RolePageResponseDto>;
    expect(byNameBody.data.total).toBe(2);
    for (const row of byNameBody.data.list) {
      expect(row.name).toContain('管理');
    }

    const byStatus = await api.get('/roles?status=0').expect(200);
    const byStatusBody = byStatus.body as ResponseEnvelope<RolePageResponseDto>;
    expect(byStatusBody.data.total).toBe(1);
    expect(byStatusBody.data.list[0].name).toBe('管理员乙');
  });

  it('5. pageSize 上限：?pageSize=101 → 400 / 10001', async () => {
    const response = await api.get('/roles?pageSize=101').expect(400);
    const body = response.body as ResponseEnvelope<null>;

    expect(body.code).toBe(ErrorCode.PARAM_INVALID);
  });

  it('6. create → 201；同名不同码 → 201；同码 → 409 / 22102；code 含大写或中划线 → 400 / 10001', async () => {
    await createRole('同码测试', 'dup_code_1');

    // 同名不同码：名字不唯一，按 code 区分
    await createRole('同码测试', 'dup_code_2');

    const conflict = await api
      .post('/roles')
      .send({ name: '再来一个', code: 'dup_code_1' })
      .expect(409);
    expect((conflict.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.ROLE_CODE_TAKEN,
    );

    const upper = await api
      .post('/roles')
      .send({ name: '大写编码', code: 'BadCode' })
      .expect(400);
    expect((upper.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PARAM_INVALID,
    );

    const hyphen = await api
      .post('/roles')
      .send({ name: '中划线编码', code: 'bad-code' })
      .expect(400);
    expect((hyphen.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PARAM_INVALID,
    );
  });

  it('7. findOne → 200 且 permissionIds: []；不存在的 id → 404 / 22101', async () => {
    const created = await createRole('详情角色', 'detail_role');

    const response = await api.get(`/roles/${created.id}`).expect(200);
    const body = response.body as ResponseEnvelope<RoleDetailResponseDto>;
    expect(body.data).toMatchObject({
      id: created.id,
      name: '详情角色',
      code: 'detail_role',
      permissionIds: [],
    });

    const missing = await api.get('/roles/999999').expect(404);
    expect((missing.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.ROLE_NOT_FOUND,
    );
  });

  it('8. update name → 200；update 改成已存在的 code → 409 / 22102', async () => {
    const created = await createRole('待改名', 'update_role_1');
    await createRole('占码的', 'update_role_2');

    const renamed = await api
      .put(`/roles/${created.id}`)
      .send({ name: '改过名了' })
      .expect(200);
    const renamedBody = renamed.body as ResponseEnvelope<RoleResponseDto>;
    expect(renamedBody.data.name).toBe('改过名了');
    expect(renamedBody.data.code).toBe('update_role_1');

    const conflict = await api
      .put(`/roles/${created.id}`)
      .send({ name: '改过名了', code: 'update_role_2' })
      .expect(409);
    expect((conflict.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.ROLE_CODE_TAKEN,
    );
  });

  it('8a. update 传 code: null → 400（null 不是「不改动」）', async () => {
    // 见证过红：守卫删掉后这条 PUT 落到 500——PartialType 给 code 补的
    // @IsOptional() 放行 null，`{ code: null }` 被原样送进 Prisma，
    // 在 NOT NULL 列上炸。挡在 Service 的理由见 role.service.ts update()。
    // 断言形状照 dept.e2e-spec「PUT 传 sortOrder: null」那条：400 + 文案点名字段
    //（Service 层 PARAM_INVALID 的外壳是 data: null，字段名在 message 里）。
    const created = await createRole('空编码测试', 'null_code_role');

    const response = await api
      .put(`/roles/${created.id}`)
      .send({ name: 'ok', code: null })
      .expect(400);

    const body = response.body as ResponseEnvelope<null>;

    expect(body.code).toBe(ErrorCode.PARAM_INVALID);
    expect(body.message).toContain('code');
  });

  it('8b. update 传 code: null 且 status: null → 400，文案同时点名两个字段', async () => {
    // nullFields.join('、') 的效果：多字段请求里必须看得出是哪几个字段。
    // 守卫删掉时这条同样落到 500（NOT NULL 列被写 null）。
    const created = await createRole('空码空状态测试', 'null_both_role');

    const response = await api
      .put(`/roles/${created.id}`)
      .send({ name: 'ok', code: null, status: null })
      .expect(400);

    const body = response.body as ResponseEnvelope<null>;

    expect(body.code).toBe(ErrorCode.PARAM_INVALID);
    expect(body.message).toContain('code');
    expect(body.message).toContain('status');
  });

  it('9. assignPermissions 差集：[A,B] → [A,B]，再 [B,C] → [B,C]，连接行只剩两行', async () => {
    const created = await createRole('差集角色', 'diff_role');
    const roleId = BigInt(created.id);

    const first = await api
      .put(`/roles/${created.id}/permissions`)
      .send({ permissionIds: [permA, permB] })
      .expect(200);
    const firstBody = first.body as ResponseEnvelope<RoleDetailResponseDto>;
    expect([...firstBody.data.permissionIds].sort()).toEqual(
      [permA, permB].sort(),
    );

    const second = await api
      .put(`/roles/${created.id}/permissions`)
      .send({ permissionIds: [permB, permC] })
      .expect(200);
    const secondBody = second.body as ResponseEnvelope<RoleDetailResponseDto>;
    expect([...secondBody.data.permissionIds].sort()).toEqual(
      [permB, permC].sort(),
    );

    const refRows = await prisma.client.sysRolePermission.findMany({
      where: { roleId },
      select: { permissionId: true },
    });
    expect(refRows).toHaveLength(2);
    expect(refRows.map((row) => row.permissionId.toString()).sort()).toEqual(
      [permB, permC].sort(),
    );
  });

  it('10. 撤销后重新授予：[A,B] → [A] → [A,B] → 200，连接行数为 2', async () => {
    const created = await createRole('重授角色', 'regrant_role');
    const roleId = BigInt(created.id);

    await api
      .put(`/roles/${created.id}/permissions`)
      .send({ permissionIds: [permA, permB] })
      .expect(200);
    await api
      .put(`/roles/${created.id}/permissions`)
      .send({ permissionIds: [permA] })
      .expect(200);
    await api
      .put(`/roles/${created.id}/permissions`)
      .send({ permissionIds: [permA, permB] })
      .expect(200);

    // DB-10 做错（连接行软删）时，这里会撞唯一约束或留下幽灵行——稳定复现
    const refRows = await prisma.client.sysRolePermission.count({
      where: { roleId },
    });
    expect(refRows).toBe(2);
  });

  it('11. assignPermissions 空数组 → 清空，permissionIds: []', async () => {
    const created = await createRole('清空角色', 'clear_role');

    await api
      .put(`/roles/${created.id}/permissions`)
      .send({ permissionIds: [permA, permB] })
      .expect(200);

    const cleared = await api
      .put(`/roles/${created.id}/permissions`)
      .send({ permissionIds: [] })
      .expect(200);
    const body = cleared.body as ResponseEnvelope<RoleDetailResponseDto>;
    expect(body.data.permissionIds).toEqual([]);

    const refCount = await prisma.client.sysRolePermission.count({
      where: { roleId: BigInt(created.id) },
    });
    expect(refCount).toBe(0);
  });

  it('12. assignPermissions 有不存在的 ID → 404 / 23101', async () => {
    const created = await createRole('幽灵权限角色', 'ghost_perm_role');

    const response = await api
      .put(`/roles/${created.id}/permissions`)
      .send({ permissionIds: [permA, '999999'] })
      .expect(404);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PERMISSION_NOT_FOUND,
    );

    // 没有任何写入落库
    const refCount = await prisma.client.sysRolePermission.count({
      where: { roleId: BigInt(created.id) },
    });
    expect(refCount).toBe(0);
  });

  it('13. assignPermissions 重复 ID → 200，去重后连接行数正确', async () => {
    const created = await createRole('重复目标角色', 'dup_target_role');
    const roleId = BigInt(created.id);

    const response = await api
      .put(`/roles/${created.id}/permissions`)
      .send({ permissionIds: [permA, permA, permB] })
      .expect(200);
    const body = response.body as ResponseEnvelope<RoleDetailResponseDto>;
    expect(body.data.permissionIds.sort()).toEqual([permA, permB].sort());

    const refCount = await prisma.client.sysRolePermission.count({
      where: { roleId },
    });
    expect(refCount).toBe(2);
  });

  it('14. delete 带成员 → 204（不拒绝！），两张连接行全部消失', async () => {
    const created = await createRole('带成员角色', 'member_role');
    const roleId = BigInt(created.id);

    await api
      .put(`/roles/${created.id}/permissions`)
      .send({ permissionIds: [permA] })
      .expect(200);

    const holder = await seedHolder('role-member-holder');
    await linkUserRole(holder.userId, roleId);

    expect(
      await prisma.client.sysUserRole.count({ where: { roleId } }),
    ).toBeGreaterThan(0);
    expect(
      await prisma.client.sysRolePermission.count({ where: { roleId } }),
    ).toBeGreaterThan(0);

    await api.delete(`/roles/${created.id}`).expect(204);

    expect(await prisma.client.sysUserRole.count({ where: { roleId } })).toBe(
      0,
    );
    expect(
      await prisma.client.sysRolePermission.count({ where: { roleId } }),
    ).toBe(0);
  });

  it('15. R10 ①：给角色设权限后，持有者 auth:perms:<userId> 被清', async () => {
    const created = await createRole('缓存探针角色', 'cache_probe_role');
    const roleId = BigInt(created.id);

    const holder = await seedHolder('role-cache-holder');
    await linkUserRole(holder.userId, roleId);

    const cacheKey = redisKeys.auth.permissions(holder.userId);
    await redis.client.set(cacheKey, JSON.stringify(['probe:a']));

    await api
      .put(`/roles/${created.id}/permissions`)
      .send({ permissionIds: [permB] })
      .expect(200);

    expect(await redis.client.get(cacheKey)).toBeNull();
  });

  it('16. R10 ②：status 0↔1 变化 → 缓存被清；设成同值 → 缓存仍在', async () => {
    const created = await createRole('状态探针角色', 'status_probe_role', 1);
    const roleId = BigInt(created.id);

    const holder = await seedHolder('role-status-holder');
    await linkUserRole(holder.userId, roleId);

    const cacheKey = redisKeys.auth.permissions(holder.userId);

    // 异值：1 → 0，缓存必须被清
    await redis.client.set(cacheKey, JSON.stringify(['probe:a']));
    await api
      .put(`/roles/${created.id}/status`)
      .send({ status: 0 })
      .expect(200);
    expect(await redis.client.get(cacheKey)).toBeNull();

    // 同值：0 → 0，缓存原样留着
    await redis.client.set(cacheKey, JSON.stringify(['probe:a']));
    await api
      .put(`/roles/${created.id}/status`)
      .send({ status: 0 })
      .expect(200);
    expect(await redis.client.get(cacheKey)).not.toBeNull();
  });

  it('17. R10 ⑥：delete 带成员的角色 → 持有者缓存被清', async () => {
    const created = await createRole('删除缓存角色', 'delete_cache_role');
    const roleId = BigInt(created.id);

    await api
      .put(`/roles/${created.id}/permissions`)
      .send({ permissionIds: [permA] })
      .expect(200);

    const holder = await seedHolder('role-delete-holder');
    await linkUserRole(holder.userId, roleId);

    const cacheKey = redisKeys.auth.permissions(holder.userId);
    await redis.client.set(cacheKey, JSON.stringify(['probe:a']));

    await api.delete(`/roles/${created.id}`).expect(204);

    expect(await redis.client.get(cacheKey)).toBeNull();
  });
});
