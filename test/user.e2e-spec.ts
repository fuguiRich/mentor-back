import { spawnSync } from 'node:child_process';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'node:http';
import { compareSync } from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { ErrorCode } from '../src/common/constants/error-code';
import { redisKeys } from '../src/infra/redis/redis-keys';
import type { FieldErrorDto } from '../src/common/dto/field-error.dto';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import type { PermissionResponseDto } from '../src/modules/permission/dto/permission-response.dto';
import type { RoleResponseDto } from '../src/modules/role/dto/role-response.dto';
import type { UserDetailResponseDto } from '../src/modules/user/dto/user-detail-response.dto';
import type { UserPageResponseDto } from '../src/modules/user/dto/user-page-response.dto';
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

describe('用户 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let api: E2eApi;
  let rootDeptId: bigint;
  let admin: SeededUser;

  /** 角色 A / B / C（建号与分配角色的绑定目标） */
  let roleA: RoleResponseDto;
  let roleB: RoleResponseDto;
  let roleC: RoleResponseDto;

  /** 探针角色：只带 user:list，供「旧令牌是否还活着」的 200/401 分野 */
  let probeRole: RoleResponseDto;

  /** 权限码 → 权限点 ID（本套件内造的，清表后为空字典） */
  const permissionIds = new Map<string, string>();

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
    const tokens = await loginAs(app, admin.username, admin.password);
    api = authedAgent(app, tokens.accessToken);

    const root = await prisma.client.sysDept.findFirst({
      where: { name: '总公司' },
    });
    if (root === null) {
      throw new Error('seedSuperAdmin 未种出「总公司」部门');
    }
    rootDeptId = root.id;

    roleA = await createRole('探针角色甲', 'probe_role_a');
    roleB = await createRole('探针角色乙', 'probe_role_b');
    roleC = await createRole('探针角色丙', 'probe_role_c');

    // supertest 7 会在「没有在途请求」时自动 close 掉自动起的 server。
    // await 必须放在请求链**外**：写进 .send() 会让中间那次请求先 settle
    // （pending 归零 → server 被关），随后本请求的 dispatch 拿到 address()=null。
    const listPermissionId = await ensurePermissionId('user:list');
    probeRole = await createRole('探针列表角色', 'probe_list_role');
    await api
      .put(`/roles/${probeRole.id}/permissions`)
      .send({ permissionIds: [listPermissionId] })
      .expect(200);
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
    dataScope?: string,
  ): Promise<RoleResponseDto> {
    const response = await api
      .post('/roles')
      .send({
        name,
        code,
        status,
        ...(dataScope === undefined ? {} : { dataScope }),
      })
      .expect(201);
    return (response.body as ResponseEnvelope<RoleResponseDto>).data;
  }

  async function ensurePermissionId(code: string): Promise<string> {
    const cached = permissionIds.get(code);
    if (cached !== undefined) {
      return cached;
    }
    const response = await api
      .post('/permissions')
      .send({ type: 'BUTTON', code, name: `探针权限 ${code}` })
      .expect(201);
    const id = (response.body as ResponseEnvelope<PermissionResponseDto>).data
      .id;
    permissionIds.set(code, id);
    return id;
  }

  async function linkUserRole(userId: bigint, roleId: bigint): Promise<void> {
    await prisma.client.sysUserRole.create({
      data: { userId, roleId, createdBy: 0n, updatedBy: 0n },
    });
  }

  /** 受限建号的 6 字段白名单（password 缺省不给 → 随机生成） */
  function accountBody(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      username: 'created-user',
      realName: '新建用户',
      employeeNo: 'CU0001',
      deptId: rootDeptId.toString(),
      roleIds: [roleA.id],
      ...overrides,
    };
  }

  /**
   * 种一个持有指定权限码的非超管账号：权限点 → 角色 → 用户 → 连接行。
   * 角色编码只能是 [a-z][a-z0-9_]*，用户名里的中划线换成下划线。
   */
  async function seedOperator(
    username: string,
    codes: string[],
  ): Promise<{ user: SeededUser; token: string }> {
    const permIds: string[] = [];
    for (const code of codes) {
      permIds.push(await ensurePermissionId(code));
    }
    const role = await createRole(
      `操作角色 ${username}`,
      `op_${username.replace(/-/g, '_')}`,
    );
    await api
      .put(`/roles/${role.id}/permissions`)
      .send({ permissionIds: permIds })
      .expect(200);

    const user = await seedUser(prisma, { username, deptId: rootDeptId });
    await linkUserRole(user.userId, BigInt(role.id));
    const tokens = await loginAs(app, username, user.password);
    return { user, token: tokens.accessToken };
  }

  async function createAccountViaApi(
    overrides: Record<string, unknown> = {},
  ): Promise<UserDetailResponseDto> {
    const response = await api
      .post('/users/account')
      .send(accountBody(overrides))
      .expect(201);
    return (response.body as ResponseEnvelope<UserDetailResponseDto>).data;
  }

  it('1. 未登录 GET /users → 401 / 10002；只有 user:list 的账号 POST /users/account → 403 / 10003', async () => {
    const anonymous = await request(app.getHttpServer() as Server)
      .get('/users')
      .expect(401);
    const anonymousBody = anonymous.body as ResponseEnvelope<null>;
    expect(anonymousBody.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(anonymousBody.data).toBeNull();

    const { token } = await seedOperator('only-list-user', ['user:list']);
    const forbidden = await authedAgent(app, token)
      .post('/users/account')
      .send(accountBody({ username: 'should-fail' }))
      .expect(403);
    const forbiddenBody = forbidden.body as ResponseEnvelope<null>;
    expect(forbiddenBody.code).toBe(ErrorCode.FORBIDDEN);
    expect(forbiddenBody.message).toContain('user:create');
  });

  it('判据 1：删掉的 4 条 users 路由全部 404（不是 403 / 405），持旧权限码也一样', async () => {
    await api
      .post('/users')
      .send(accountBody({ username: 'ghost-route' }))
      .expect(404);
    await api
      .put(`/users/${admin.userId.toString()}`)
      .send({ username: admin.username })
      .expect(404);
    await api.delete(`/users/${admin.userId.toString()}`).expect(404);
    await api.delete(`/users/${admin.userId.toString()}/purge`).expect(404);

    // 路由没了 → RequirePermission 那层也没了：持 user:create 的账号也拿 404，
    // 而不是「路由还在、被权限挡下」的 403。
    const { token } = await seedOperator('old-creator', ['user:create']);
    await authedAgent(app, token)
      .post('/users')
      .send({ username: 'ghost-route-2' })
      .expect(404);
  });

  it('判据 2：POST /users/account → 201；status=1、password 是 bcrypt、SysUserRole 落去重后 N 行、响应不含 password', async () => {
    const created = await createAccountViaApi({
      username: 'created-user',
      employeeNo: 'CU0001',
      roleIds: [roleA.id, roleA.id, roleB.id],
    });

    expect(created.id).toBeDefined();
    expect(created.username).toBe('created-user');
    expect([...created.roleIds].sort()).toEqual([roleA.id, roleB.id].sort());
    expect(Object.keys(created)).not.toContain('password');
    // R4 兜底：审计字段的 created_by 是当前登录用户（ALS 上下文里的 actor）
    expect(created.createdBy).toBe(admin.userId.toString());
    expect(created.createdBy).not.toBe('0');

    const row = await prisma.client.sysUser.findFirst({
      where: { username: 'created-user' },
    });
    expect(row).not.toBeNull();
    expect(row?.status).toBe(1);
    expect(row?.password).toMatch(/^\$2/);
    expect(row?.isSuperAdmin).toBe(false);
    expect(row?.createdBy).toBe(admin.userId);

    // N = 去重后的 roleIds 长度（入参 [A, A, B] → 2 行）
    expect(
      await prisma.client.sysUserRole.count({
        where: { userId: BigInt(created.id) },
      }),
    ).toBe(2);
  });

  it('判据 2b：给定 password → 落库值 = hashSync(给的那个)；响应同样不含 password', async () => {
    const created = await createAccountViaApi({
      username: 'given-pw-user',
      employeeNo: 'CU0002',
      password: 'Given123!',
      roleIds: [roleC.id],
    });
    expect(Object.keys(created)).not.toContain('password');

    const row = await prisma.client.sysUser.findFirst({
      where: { username: 'given-pw-user' },
    });
    expect(row).not.toBeNull();
    // bcrypt 每次换盐，「等于 hashSync(…)」在 e2e 层的可测读数是
    // 「给的口令能校验通过、别的不能」——等号落在校验语义上。
    expect(compareSync('Given123!', row?.password ?? '')).toBe(true);
    expect(compareSync('Wrong123!', row?.password ?? '')).toBe(false);

    const relogin = await loginAs(app, 'given-pw-user', 'Given123!');
    expect(relogin.accessToken).toBeDefined();
  });

  it('判据 3：roleIds: [] → 400 / 10001，账号不创建', async () => {
    const response = await api
      .post('/users/account')
      .send(accountBody({ username: 'empty-roles', roleIds: [] }))
      .expect(400);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PARAM_INVALID,
    );

    const page = await api.get('/users?username=empty-roles').expect(200);
    expect(
      (page.body as ResponseEnvelope<UserPageResponseDto>).data.total,
    ).toBe(0);
  });

  it('判据 4：roleIds 含不存在的 ID → 404 / 22101，账号不创建', async () => {
    const response = await api
      .post('/users/account')
      .send(
        accountBody({
          username: 'ghost-role-user',
          // createAccount 先查 username/employeeNo 占用（§3.3 顺序），employeeNo
          // 沿用默认值会撞上判据 2 的 CU0001、先拿 409 而非 404——这行必须唯一。
          employeeNo: 'GHOST-R',
          roleIds: [roleA.id, '999999'],
        }),
      )
      .expect(404);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.ROLE_NOT_FOUND,
    );

    const page = await api.get('/users?username=ghost-role-user').expect(200);
    expect(
      (page.body as ResponseEnvelope<UserPageResponseDto>).data.total,
    ).toBe(0);
  });

  it('判据 5：username 重复 → 409 / 21102', async () => {
    await createAccountViaApi({ username: 'dup-src-1', employeeNo: 'DUP-E1' });

    const response = await api
      .post('/users/account')
      .send(accountBody({ username: 'dup-src-1', employeeNo: 'DUP-E2' }))
      .expect(409);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.USER_NAME_TAKEN,
    );
  });

  it('判据 6：employeeNo 重复 → 409 / 21103', async () => {
    const response = await api
      .post('/users/account')
      .send(accountBody({ username: 'dup-src-2', employeeNo: 'DUP-E1' }))
      .expect(409);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.USER_EMPLOYEE_NO_TAKEN,
    );
  });

  it('判据 7：isSuperAdmin: true / mobile 塞进请求体 → 400 / 10001，账号不创建', async () => {
    const byFlag = await api
      .post('/users/account')
      .send(
        accountBody({
          username: 'sneaky-super',
          employeeNo: 'SNEAK1',
          isSuperAdmin: true,
        }),
      )
      .expect(400);
    const byFlagBody = byFlag.body as ResponseEnvelope<{
      fields: FieldErrorDto[];
    }>;
    expect(byFlagBody.code).toBe(ErrorCode.PARAM_INVALID);
    expect(byFlagBody.data.fields[0].field).toBe('isSuperAdmin');

    const byMobile = await api
      .post('/users/account')
      .send(
        accountBody({
          username: 'sneaky-mobile',
          employeeNo: 'SNEAK2',
          mobile: '13800000000',
        }),
      )
      .expect(400);
    const byMobileBody = byMobile.body as ResponseEnvelope<{
      fields: FieldErrorDto[];
    }>;
    expect(byMobileBody.code).toBe(ErrorCode.PARAM_INVALID);
    expect(byMobileBody.data.fields[0].field).toBe('mobile');

    for (const name of ['sneaky-super', 'sneaky-mobile']) {
      const page = await api.get(`/users?username=${name}`).expect(200);
      expect(
        (page.body as ResponseEnvelope<UserPageResponseDto>).data.total,
      ).toBe(0);
    }
  });

  it('§3.3.3：deptId 不存在 → 400 / 10001（不是 24101）', async () => {
    const response = await api
      .post('/users/account')
      .send(
        accountBody({
          username: 'ghost-dept',
          employeeNo: 'GHOST1',
          deptId: '999999',
        }),
      )
      .expect(400);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PARAM_INVALID,
    );

    const page = await api.get('/users?username=ghost-dept').expect(200);
    expect(
      (page.body as ResponseEnvelope<UserPageResponseDto>).data.total,
    ).toBe(0);
  });

  it('6. 分页结构：造 3 个用户，?page=1&pageSize=2 → { list: 2, total: 3, page: 1, pageSize: 2 }；不传分页参数 → page: 1, pageSize: 20；?pageSize=101 → 400 / 10001', async () => {
    // 这 3 个用户用 username 前缀圈成一组：套件里还有超管与前序用例的账号，
    // 不加过滤 total 撑不出 3。断言值仍是分页结构本身。
    for (const name of ['pagecase1', 'pagecase2', 'pagecase3']) {
      await createAccountViaApi({
        username: name,
        employeeNo: `PAGE-${name}`,
        realName: `分页${name}`,
      });
    }

    const page1 = await api
      .get('/users?username=pagecase&page=1&pageSize=2')
      .expect(200);
    const page1Body = page1.body as ResponseEnvelope<UserPageResponseDto>;
    expect(page1Body.code).toBe(0);
    expect(page1Body.data.list).toHaveLength(2);
    expect(page1Body.data.total).toBe(3);
    expect(page1Body.data.page).toBe(1);
    expect(page1Body.data.pageSize).toBe(2);

    const defaults = await api.get('/users?username=pagecase').expect(200);
    const defaultsBody = defaults.body as ResponseEnvelope<UserPageResponseDto>;
    expect(defaultsBody.data.page).toBe(1);
    expect(defaultsBody.data.pageSize).toBe(20);

    const tooBig = await api.get('/users?pageSize=101').expect(400);
    expect((tooBig.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PARAM_INVALID,
    );
  });

  it('7. 六个筛选：username / realName / employeeNo 模糊；deptId 精确；status=0；roleId 只回持有者', async () => {
    await createAccountViaApi({
      username: 'fuzzy-a',
      realName: '筛姓甲',
      employeeNo: 'FLT-A1',
    });
    await createAccountViaApi({
      username: 'fuzzy-ab',
      realName: '筛姓乙',
      employeeNo: 'FLT-B1',
    });

    const byUsername = await api.get('/users?username=fuzzy-').expect(200);
    const byUsernameBody =
      byUsername.body as ResponseEnvelope<UserPageResponseDto>;
    expect(byUsernameBody.data.total).toBe(2);
    for (const row of byUsernameBody.data.list) {
      expect(row.username).toContain('fuzzy-');
    }

    const byRealName = await api.get('/users?realName=筛姓').expect(200);
    const byRealNameBody =
      byRealName.body as ResponseEnvelope<UserPageResponseDto>;
    expect(byRealNameBody.data.total).toBe(2);
    for (const row of byRealNameBody.data.list) {
      expect(row.realName).toContain('筛姓');
    }

    const byEmployeeNo = await api.get('/users?employeeNo=FLT-').expect(200);
    const byEmployeeNoBody =
      byEmployeeNo.body as ResponseEnvelope<UserPageResponseDto>;
    expect(byEmployeeNoBody.data.total).toBe(2);
    for (const row of byEmployeeNoBody.data.list) {
      expect(row.employeeNo).toContain('FLT-');
    }

    // deptId 精确匹配本部门（不含下级）
    const secondDept = await prisma.client.sysDept.create({
      data: {
        parentId: null,
        name: '筛选部门',
        sortOrder: 9,
        status: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    await createAccountViaApi({
      username: 'dept2-user',
      employeeNo: 'DEP2-1',
      deptId: secondDept.id.toString(),
    });

    const byDept = await api
      .get(`/users?deptId=${secondDept.id.toString()}`)
      .expect(200);
    const byDeptBody = byDept.body as ResponseEnvelope<UserPageResponseDto>;
    expect(byDeptBody.data.total).toBe(1);
    expect(byDeptBody.data.list[0].username).toBe('dept2-user');

    // 建号入口不收 status（建号即定型），停用的账号用直插造——
    // 这里测的是「status=0 筛得出来」，不是「建号能设 status」。
    await seedUser(prisma, {
      username: 'disabled-user',
      deptId: rootDeptId,
      status: 0,
    });
    const byStatus = await api.get('/users?status=0').expect(200);
    const byStatusBody = byStatus.body as ResponseEnvelope<UserPageResponseDto>;
    for (const row of byStatusBody.data.list) {
      expect(row.status).toBe(0);
    }
    expect(
      byStatusBody.data.list.some((row) => row.username === 'disabled-user'),
    ).toBe(true);

    // roleId 只回持有者
    const holderRole = await createRole('持有人角色', 'holder_only_role');
    const holder = await seedUser(prisma, {
      username: 'role-holder',
      deptId: rootDeptId,
    });
    await linkUserRole(holder.userId, BigInt(holderRole.id));
    await seedUser(prisma, { username: 'role-bystander', deptId: rootDeptId });

    const byRole = await api.get(`/users?roleId=${holderRole.id}`).expect(200);
    const byRoleBody = byRole.body as ResponseEnvelope<UserPageResponseDto>;
    expect(byRoleBody.data.total).toBe(1);
    expect(byRoleBody.data.list[0].username).toBe('role-holder');
  });

  it('8. R13：?roleId= 传一个不存在的角色 ID → 200 且 total: 0', async () => {
    const response = await api.get('/users?roleId=999999').expect(200);
    const body = response.body as ResponseEnvelope<UserPageResponseDto>;
    expect(body.code).toBe(0);
    expect(body.data.total).toBe(0);
    expect(body.data.list).toEqual([]);
  });

  it('9. detail → 200 且 roleIds 回显、不含 password；不存在的 id → 404 / 21101', async () => {
    const created = await createAccountViaApi({
      username: 'detail-user',
      employeeNo: 'DET-1',
      roleIds: [roleB.id],
    });

    const response = await api.get(`/users/${created.id}`).expect(200);
    const body = response.body as ResponseEnvelope<UserDetailResponseDto>;
    expect(body.data.id).toBe(created.id);
    expect(body.data.username).toBe('detail-user');
    expect(body.data.roleIds).toEqual([roleB.id]);
    expect(Object.keys(body.data)).not.toContain('password');

    const missing = await api.get('/users/999999').expect(404);
    expect((missing.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.USER_NOT_FOUND,
    );
  });

  it('18. status：1→0 → 200，且旧 access token 随后请求 → 401（R14）；0→1 → 200 且旧 token 仍可用（启用不作废）；设成同值 → 不作废', async () => {
    // 探针用户挂 probeRole（带 user:list）：活着的令牌打 GET /users 得 200，
    // 死掉的得 401——200/401 的分野就是「启用到底作废没作废」的读数。
    // 1→0：作废令牌
    const disabling = await seedUser(prisma, {
      username: 'status-disable',
      deptId: rootDeptId,
    });
    await linkUserRole(disabling.userId, BigInt(probeRole.id));
    const disablingTokens = await loginAs(
      app,
      disabling.username,
      disabling.password,
    );
    await authedAgent(app, disablingTokens.accessToken)
      .get('/users')
      .expect(200);

    await api
      .put(`/users/${disabling.userId.toString()}/status`)
      .send({ status: 0 })
      .expect(200);
    await authedAgent(app, disablingTokens.accessToken)
      .get('/users')
      .expect(401);

    // 0→1：启用这一步本身不作废令牌。先用 Prisma 把账号置停用
    // （正常停用路径会连令牌一起作废，那样就观察不到「启用」这一步了），
    // 拿着停用前签发的活令牌跨过 0→1，它必须还活着。
    const enabling = await seedUser(prisma, {
      username: 'status-enable',
      deptId: rootDeptId,
    });
    await linkUserRole(enabling.userId, BigInt(probeRole.id));
    const enablingTokens = await loginAs(
      app,
      enabling.username,
      enabling.password,
    );
    await prisma.client.sysUser.update({
      where: { id: enabling.userId },
      data: { status: 0 },
    });

    await api
      .put(`/users/${enabling.userId.toString()}/status`)
      .send({ status: 1 })
      .expect(200);
    await authedAgent(app, enablingTokens.accessToken)
      .get('/users')
      .expect(200);

    // 同值：不作废
    const same = await seedUser(prisma, {
      username: 'status-same',
      deptId: rootDeptId,
    });
    await linkUserRole(same.userId, BigInt(probeRole.id));
    const sameTokens = await loginAs(app, same.username, same.password);

    await api
      .put(`/users/${same.userId.toString()}/status`)
      .send({ status: 1 })
      .expect(200);
    await authedAgent(app, sameTokens.accessToken).get('/users').expect(200);
  });

  it('19. resetPassword：→ 200，旧 token 401（R14），新密码可登录', async () => {
    const target = await seedUser(prisma, {
      username: 'reset-target',
      deptId: rootDeptId,
    });
    const oldTokens = await loginAs(app, target.username, target.password);

    await api
      .put(`/users/${target.userId.toString()}/password`)
      .send({ password: 'NewPass1!' })
      .expect(200);

    await authedAgent(app, oldTokens.accessToken).get('/users').expect(401);

    const relogin = await loginAs(app, target.username, 'NewPass1!');
    expect(relogin.accessToken).toBeDefined();
  });

  it('20. R21：非超管（持 user:reset-password）重置超管的密码 → 403 / 10003', async () => {
    const { token } = await seedOperator('resetter-user', [
      'user:reset-password',
    ]);

    const response = await authedAgent(app, token)
      .put(`/users/${admin.userId.toString()}/password`)
      .send({ password: 'Hijack1!!' })
      .expect(403);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );

    // 超管的密码没被动过：原密码还能登录
    const stillWorks = await loginAs(app, admin.username, admin.password);
    expect(stillWorks.accessToken).toBeDefined();
  });

  it('21. assignRoles 差集：设 [A,B] → detail 是 [A,B]；再设 [B,C] → [B,C]，Prisma 直查 sys_user_role 只剩两行', async () => {
    const target = await seedUser(prisma, {
      username: 'assign-diff',
      deptId: rootDeptId,
    });
    const userId = target.userId;

    const first = await api
      .put(`/users/${userId.toString()}/roles`)
      .send({ roleIds: [roleA.id, roleB.id] })
      .expect(200);
    const firstBody = first.body as ResponseEnvelope<UserDetailResponseDto>;
    expect([...firstBody.data.roleIds].sort()).toEqual(
      [roleA.id, roleB.id].sort(),
    );

    const second = await api
      .put(`/users/${userId.toString()}/roles`)
      .send({ roleIds: [roleB.id, roleC.id] })
      .expect(200);
    const secondBody = second.body as ResponseEnvelope<UserDetailResponseDto>;
    expect([...secondBody.data.roleIds].sort()).toEqual(
      [roleB.id, roleC.id].sort(),
    );

    expect(await prisma.client.sysUserRole.count({ where: { userId } })).toBe(
      2,
    );
  });

  it('22. 撤销后重新授予（spec 最小回归集，DB-10）：[A,B] → [A] → [A,B] → 200，连接行数为 2', async () => {
    const target = await seedUser(prisma, {
      username: 'assign-regrant',
      deptId: rootDeptId,
    });
    const userId = target.userId;

    await api
      .put(`/users/${userId.toString()}/roles`)
      .send({ roleIds: [roleA.id, roleB.id] })
      .expect(200);
    await api
      .put(`/users/${userId.toString()}/roles`)
      .send({ roleIds: [roleA.id] })
      .expect(200);
    await api
      .put(`/users/${userId.toString()}/roles`)
      .send({ roleIds: [roleA.id, roleB.id] })
      .expect(200);

    // DB-10 做错（连接行软删）时，这里会撞唯一约束或留下幽灵行——稳定复现
    expect(await prisma.client.sysUserRole.count({ where: { userId } })).toBe(
      2,
    );
  });

  it('23. assignRoles 空数组 → 清空；重复 ID → 去重后连接行数正确；不存在的角色 → 404 / 22101', async () => {
    const target = await seedUser(prisma, {
      username: 'assign-edge',
      deptId: rootDeptId,
    });
    const userId = target.userId;

    await api
      .put(`/users/${userId.toString()}/roles`)
      .send({ roleIds: [roleA.id, roleB.id] })
      .expect(200);

    const cleared = await api
      .put(`/users/${userId.toString()}/roles`)
      .send({ roleIds: [] })
      .expect(200);
    const clearedBody = cleared.body as ResponseEnvelope<UserDetailResponseDto>;
    expect(clearedBody.data.roleIds).toEqual([]);
    expect(await prisma.client.sysUserRole.count({ where: { userId } })).toBe(
      0,
    );

    const deduped = await api
      .put(`/users/${userId.toString()}/roles`)
      .send({ roleIds: [roleA.id, roleA.id, roleB.id] })
      .expect(200);
    const dedupedBody = deduped.body as ResponseEnvelope<UserDetailResponseDto>;
    expect([...dedupedBody.data.roleIds].sort()).toEqual(
      [roleA.id, roleB.id].sort(),
    );
    expect(await prisma.client.sysUserRole.count({ where: { userId } })).toBe(
      2,
    );

    const ghost = await api
      .put(`/users/${userId.toString()}/roles`)
      .send({ roleIds: [roleA.id, '999999'] })
      .expect(404);
    expect((ghost.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.ROLE_NOT_FOUND,
    );
  });

  it('24. R10 ③：assignRoles 后该用户的 auth:perms:<userId> 被清', async () => {
    const target = await seedUser(prisma, {
      username: 'cache-probe-user',
      deptId: rootDeptId,
    });

    const cacheKey = redisKeys.auth.permissions(target.userId);
    await redis.client.set(cacheKey, JSON.stringify(['user:list']));

    await api
      .put(`/users/${target.userId.toString()}/roles`)
      .send({ roleIds: [roleA.id] })
      .expect(200);

    expect(await redis.client.get(cacheKey)).toBeNull();
  });

  it('25. R7④：非超管（持 user:update）经 PUT /users/:id/status 停用超管 → 409 / 21105（不是 200）', async () => {
    const { token } = await seedOperator('status-updater', ['user:update']);

    const response = await authedAgent(app, token)
      .put(`/users/${admin.userId.toString()}/status`)
      .send({ status: 0 })
      .expect(409);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.USER_SUPER_ADMIN_PROTECTED,
    );
  });

  // ── 数据范围（Task 7 判据 1-5）：@DataScope 上限 + 越权 403 ─────────────────
  //
  // 载体是 GET /users（@DataScope('all')）。角色编码带 scope_ 前缀：
  // 末尾的 seed 套件按 code 播 student / college_admin / sc_admin，
  // 撞上它的编码会让 seed 的「补建」分支跳过，判据 8 的 remark 断言直接红。
  describe('数据范围与越权 403（判据 1-5）', () => {
    /** 部门树：总公司 → 院A → 系A1 → 组A1a；总公司 → 院B */
    const depts: Record<string, bigint> = {};

    /** 判据 1-5 共用的一台戏（种子用户默认口令） */
    const OPERATOR_PASSWORD = 'Passw0rd!';

    const CAST = [
      'scope-student',
      'scope-ca-admin',
      'scope-ca-user',
      'scope-a1-user',
      'scope-a1a-user',
      'scope-b-user',
      'scope-sc-admin',
    ] as const;

    async function createDept(
      name: string,
      parent: bigint | null,
    ): Promise<bigint> {
      const row = await prisma.client.sysDept.create({
        data: {
          parentId: parent,
          name,
          sortOrder: 0,
          status: 1,
          createdBy: 0n,
          updatedBy: 0n,
        },
      });
      return row.id;
    }

    /** 造「非超管 + 带数据范围的角色 + user:list」的账号（登录留给用例自己做） */
    async function seedScopedOperator(
      username: string,
      deptId: bigint,
      role: RoleResponseDto,
    ): Promise<void> {
      const user = await seedUser(prisma, {
        username,
        password: OPERATOR_PASSWORD,
        deptId,
      });
      await linkUserRole(user.userId, BigInt(role.id));
    }

    async function operatorAgent(username: string): Promise<E2eApi> {
      const tokens = await loginAs(app, username, OPERATOR_PASSWORD);
      return authedAgent(app, tokens.accessToken);
    }

    beforeAll(async () => {
      depts.collegeA = await createDept('范围院A', rootDeptId);
      depts.deptA1 = await createDept('范围系A1', depts.collegeA);
      depts.groupA1a = await createDept('范围组A1a', depts.deptA1);
      depts.collegeB = await createDept('范围院B', rootDeptId);

      // data_scope 对齐 prisma/seed.ts 的四个基础角色：self / deptAndChildren / all
      const listPermissionId = await ensurePermissionId('user:list');
      const roles: RoleResponseDto[] = [
        await createRole('范围学生角色', 'scope_student', 1, 'self'),
        await createRole(
          '范围院管理员角色',
          'scope_college_admin',
          1,
          'deptAndChildren',
        ),
        await createRole('范围双创管理员角色', 'scope_sc_admin', 1, 'all'),
      ];
      const [studentRole, collegeAdminRole, scAdminRole] = roles;
      for (const role of roles) {
        await api
          .put(`/roles/${role.id}/permissions`)
          .send({ permissionIds: [listPermissionId] })
          .expect(200);
      }

      await seedScopedOperator('scope-student', depts.collegeB, studentRole);
      await seedScopedOperator('scope-b-user', depts.collegeB, studentRole);
      await seedScopedOperator(
        'scope-ca-admin',
        depts.collegeA,
        collegeAdminRole,
      );
      await seedScopedOperator(
        'scope-ca-user',
        depts.collegeA,
        collegeAdminRole,
      );
      await seedScopedOperator('scope-a1-user', depts.deptA1, collegeAdminRole);
      await seedScopedOperator(
        'scope-a1a-user',
        depts.groupA1a,
        collegeAdminRole,
      );
      await seedScopedOperator('scope-sc-admin', rootDeptId, scAdminRole);
    });

    it('判据 1：student（data_scope=self）查 GET /users → 200，list 里只有自己那一行（total = 1）', async () => {
      const studentApi = await operatorAgent('scope-student');
      const body = (await studentApi.get('/users').expect(200))
        .body as ResponseEnvelope<UserPageResponseDto>;

      expect(body.data.total).toBe(1);
      expect(body.data.list).toHaveLength(1);
      expect(body.data.list[0].username).toBe('scope-student');
    });

    it('判据 2：college_admin（data_scope=deptAndChildren）不传 deptId → 200，只出本院及下级，外院一行不出现', async () => {
      const collegeApi = await operatorAgent('scope-ca-admin');
      const body = (await collegeApi.get('/users').expect(200))
        .body as ResponseEnvelope<UserPageResponseDto>;

      const names = body.data.list.map((row) => row.username).sort();
      // 本院（院A）+ 下级（系A1、组A1a）共 4 人；套件里其他用户挂在总公司 / 筛选部门，不在这棵子树里。
      // 名单是**精确的**——外院（院B）与根部门的人不在里面，正是「一行不出现」的证据。
      // 不再单写 not.toContain：名单已钉死，那些断言恒真、咬不住任何东西（空断言）。
      expect(names).toEqual(
        [
          'scope-a1-user',
          'scope-a1a-user',
          'scope-ca-admin',
          'scope-ca-user',
        ].sort(),
      );
      expect(body.data.total).toBe(4);
    });

    it('判据 3：sc_admin（data_scope=all）查 GET /users → 200，出全校（含上面两个用例里的人）', async () => {
      const scApi = await operatorAgent('scope-sc-admin');
      const body = (
        await scApi.get('/users?username=scope-&pageSize=100').expect(200)
      ).body as ResponseEnvelope<UserPageResponseDto>;

      const names = body.data.list.map((row) => row.username).sort();
      expect(names).toEqual([...CAST].sort());
      expect(body.data.total).toBe(CAST.length);
    });

    it('判据 4：越权——college_admin 传别的学院（院B）的 deptId → 403 / 10003，响应体不是空列表', async () => {
      const collegeApi = await operatorAgent('scope-ca-admin');
      const response = await collegeApi
        .get(`/users?deptId=${depts.collegeB.toString()}`)
        .expect(403);

      const body = response.body as ResponseEnvelope<null>;
      expect(body.code).toBe(ErrorCode.FORBIDDEN);
      // 不是「200 + 空列表」蒙混——data 是 null，没有 list 可看
      expect(body.data).toBeNull();
    });

    it('判据 5：范围内——college_admin 传本院的下级部门（系A1）deptId → 200，只出那个部门的用户（精确匹配，不含下级）', async () => {
      const collegeApi = await operatorAgent('scope-ca-admin');
      const body = (
        await collegeApi
          .get(`/users?deptId=${depts.deptA1.toString()}`)
          .expect(200)
      ).body as ResponseEnvelope<UserPageResponseDto>;

      expect(body.data.total).toBe(1);
      expect(body.data.list).toHaveLength(1);
      // 精确匹配：组A1a（下级的下级）与院A本级都不进来
      expect(body.data.list[0].username).toBe('scope-a1-user');
    });
  });

  // ── 判据 8 / 9：真跑 prisma/seed.ts（pnpm db:seed），不看实现看落库 ─────────
  //
  // seed 用 SEED_* 环境变量把根部门 / 超管名换成套件专用值，避免和
  // seedSuperAdmin 种的「总公司 / admin」撞唯一键——角色表与判据是环境无关的。
  // 子进程继承本进程 env（.env.test.local 的 DATABASE_URL 就是本套件连的库）；
  // seed 自己的 dotenv 不覆盖已有的环境变量。
  describe('seed 播四个角色（判据 8 / 9）', () => {
    const SEEDED_ROLES = [
      { code: 'student', dataScope: 'self' },
      { code: 'mentor', dataScope: 'self' },
      { code: 'college_admin', dataScope: 'deptAndChildren' },
      { code: 'sc_admin', dataScope: 'all' },
    ] as const;

    function runSeed(): void {
      const result = spawnSync('pnpm', ['db:seed'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SEED_ROOT_DEPT_NAME: 'seed 根部门',
          SEED_ADMIN_USERNAME: 'seed-admin-user',
          SEED_ADMIN_PASSWORD: 'SeedAdm1n!',
        },
        shell: true,
        encoding: 'utf8',
        timeout: 120_000,
      });
      if (result.status !== 0) {
        throw new Error(
          `pnpm db:seed 退出码 ${String(result.status)}：\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
        );
      }
    }

    it('判据 8：首跑 seed 四个角色补建，dataScope 逐条等于 §4 表', async () => {
      runSeed();

      for (const spec of SEEDED_ROLES) {
        const row = await prisma.client.sysRole.findFirst({
          where: { code: spec.code, deletedAt: null },
        });
        // row 为 null 时下面第一条就红，红在「该有的 code 不在」上
        expect(row?.code).toBe(spec.code);
        expect(row?.dataScope).toBe(spec.dataScope);
        expect(row?.status).toBe(1);
        expect(row?.remark).toBe('由 seed 创建');
        expect(row?.createdBy).toBe(0n);
        expect(row?.updatedBy).toBe(0n);
      }
    }, 120_000);

    it('判据 8b：重跑 seed——已存在角色的 dataScope 不被改写（手动改成 all 后仍是 all）', async () => {
      const student = await prisma.client.sysRole.findFirst({
        where: { code: 'student', deletedAt: null },
      });
      expect(student).not.toBeNull();
      await prisma.client.sysRole.update({
        where: { id: student!.id },
        data: { dataScope: 'all' },
      });

      runSeed();

      const after = await prisma.client.sysRole.findFirst({
        where: { code: 'student', deletedAt: null },
      });
      expect(after?.dataScope).toBe('all'); // 没被冲回 'self'
    }, 120_000);

    it('判据 9：老库补种——根部门 + admin 已在、角色全缺，重跑 seed 四个角色补上，且不重复建 admin / 根部门', async () => {
      // 老库 = 只播过根部门 + admin 的库。把四个角色清掉就是那个状态。
      await prisma.includingDeleted.sysRole.deleteMany({
        where: {
          code: { in: ['student', 'mentor', 'college_admin', 'sc_admin'] },
        },
      });
      expect(
        await prisma.client.sysDept.count({ where: { name: 'seed 根部门' } }),
      ).toBe(1);
      expect(
        await prisma.client.sysUser.count({
          where: { username: 'seed-admin-user' },
        }),
      ).toBe(1);

      runSeed();

      for (const spec of SEEDED_ROLES) {
        const row = await prisma.client.sysRole.findFirst({
          where: { code: spec.code, deletedAt: null },
        });
        expect(row?.code).toBe(spec.code);
      }
      // 守卫真的生效：没有重复创建根部门与 admin
      expect(
        await prisma.client.sysDept.count({ where: { name: 'seed 根部门' } }),
      ).toBe(1);
      expect(
        await prisma.client.sysUser.count({
          where: { username: 'seed-admin-user' },
        }),
      ).toBe(1);
    }, 120_000);
  });
});
