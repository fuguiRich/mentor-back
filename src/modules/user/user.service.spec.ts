import { HttpStatus } from '@nestjs/common';
import { Prisma, type SysUser } from '@prisma/client';
import { compareSync, getRounds } from 'bcryptjs';
import { BCRYPT_ROUNDS } from '../../common/constants/auth.constants';
import { ErrorCode } from '../../common/constants/error-code';
import { BusinessException } from '../../common/errors/business.exception';
import {
  requestContext,
  type RequestUser,
} from '../../common/context/request-context';
import type { SessionStore } from '../../infra/redis/session-store.service';
import type {
  DataScopeCeiling,
  DataScopeFilter,
} from '../../common/constants/data-scope';
import type { DataScopeService } from '../data-scope/data-scope.service';
import type { DeptService } from '../dept/dept.service';
import type { RoleService } from '../role/role.service';
import { UserRepository, type UserWithDeptName } from './user.repository';
import { UserService } from './user.service';
import type { CreateUserAccountDto } from './dto/create-user-account.dto';

function user(
  id: bigint,
  overrides: Partial<UserWithDeptName> = {},
): UserWithDeptName {
  return {
    id,
    username: `user_${id.toString()}`,
    password: 'hashed-password',
    realName: `用户 ${id.toString()}`,
    employeeNo: `E${id.toString()}`,
    mobile: null,
    deptId: 1n,
    status: 1,
    isSuperAdmin: false,
    lastLoginAt: null,
    createdAt: new Date('2026-10-14T00:00:00.000Z'),
    updatedAt: new Date('2026-10-14T00:00:00.000Z'),
    createdBy: 0n,
    updatedBy: 0n,
    deletedAt: null,
    deletedBy: null,
    dept: { name: '总公司' },
    ...overrides,
  };
}

function caller(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    userId: 1n,
    username: 'admin',
    isSuperAdmin: true,
    accessJti: 'jti-test',
    accessExpiresAt: 1893456000,
    ...overrides,
  };
}

function accountDto(
  overrides: Partial<CreateUserAccountDto> = {},
): CreateUserAccountDto {
  return {
    username: 'zhangsan',
    realName: '张三',
    employeeNo: 'T2026001',
    deptId: '1',
    roleIds: ['2', '3'],
    ...overrides,
  };
}

interface CallLog {
  name: string;
  args: unknown[];
}

function buildService(
  repositoryOverrides: Partial<Record<keyof UserRepository, unknown>> = {},
  roleOverrides: Partial<
    Record<
      | 'assertExists'
      | 'findRoleIdsByUserId'
      | 'replaceUserRoles'
      | 'findUserIdsByRoleId',
      unknown
    >
  > = {},
  deptOverrides: Partial<Record<'exists', unknown>> = {},
  dataScopeOverrides: Partial<{
    resolve: (
      actor: {
        userId: bigint;
        isSuperAdmin: boolean;
        deptId: bigint | null;
      },
      ceiling: DataScopeCeiling,
    ) => DataScopeFilter;
    assertDeptVisible: (filter: DataScopeFilter, deptId: bigint) => void;
  }> = {},
): {
  service: UserService;
  revoked: bigint[];
  cleared: bigint[][];
  calls: CallLog[];
  replaceArgs: { userId: bigint; toAdd: bigint[]; toRemove: bigint[] }[];
  findManyArgs: Record<string, unknown>[];
  createArgs: Record<string, unknown>[];
  boundRoleIds: bigint[];
  scopeArgs: {
    actor: { userId: bigint; isSuperAdmin: boolean; deptId: bigint | null };
    ceiling: DataScopeCeiling;
  }[];
  assertArgs: { filter: DataScopeFilter; deptId: bigint }[];
} {
  const revoked: bigint[] = [];
  const cleared: bigint[][] = [];
  const calls: CallLog[] = [];
  const replaceArgs: { userId: bigint; toAdd: bigint[]; toRemove: bigint[] }[] =
    [];
  const findManyArgs: Record<string, unknown>[] = [];
  const createArgs: Record<string, unknown>[] = [];
  const boundRoleIds: bigint[] = [];
  const scopeArgs: {
    actor: { userId: bigint; isSuperAdmin: boolean; deptId: bigint | null };
    ceiling: DataScopeCeiling;
  }[] = [];
  const assertArgs: { filter: DataScopeFilter; deptId: bigint }[] = [];

  const repository = {
    findByUsername: (): Promise<SysUser | null> => Promise.resolve(null),
    findById: (): Promise<SysUser | null> => Promise.resolve(null),
    recordLogin: (): Promise<void> => Promise.resolve(),
    findMany: (
      params: Record<string, unknown>,
    ): Promise<{ rows: UserWithDeptName[]; total: number }> => {
      findManyArgs.push(params);
      return Promise.resolve({ rows: [], total: 0 });
    },
    findByIdWithDept: (): Promise<UserWithDeptName | null> =>
      Promise.resolve(null),
    existsByUsername: (): Promise<boolean> => Promise.resolve(false),
    existsByEmployeeNo: (): Promise<boolean> => Promise.resolve(false),
    createWithRoles: (
      data: Record<string, unknown>,
      roleIds: bigint[],
    ): Promise<UserWithDeptName> => {
      createArgs.push(data);
      boundRoleIds.push(...roleIds);
      return Promise.resolve(user(1n));
    },
    update: (): Promise<UserWithDeptName> => Promise.resolve(user(1n)),
    updatePassword: (id: bigint): Promise<UserWithDeptName> => {
      calls.push({ name: 'updatePassword', args: [id] });
      return Promise.resolve(user(1n));
    },
    ...repositoryOverrides,
  } as unknown as UserRepository;

  const roles = {
    assertExists: (id: bigint): Promise<void> => {
      calls.push({ name: 'roles.assertExists', args: [id] });
      return Promise.resolve();
    },
    findRoleIdsByUserId: (): Promise<bigint[]> => Promise.resolve([]),
    replaceUserRoles: (
      userId: bigint,
      toAdd: bigint[],
      toRemove: bigint[],
    ): Promise<void> => {
      replaceArgs.push({ userId, toAdd, toRemove });
      calls.push({ name: 'replaceUserRoles', args: [userId, toAdd, toRemove] });
      return Promise.resolve();
    },
    findUserIdsByRoleId: (): Promise<bigint[]> => Promise.resolve([]),
    ...roleOverrides,
  } as unknown as RoleService;

  const depts = {
    exists: (): Promise<boolean> => Promise.resolve(true),
    ...deptOverrides,
  } as unknown as DeptService;

  const sessions = {
    revokeSessions: (userId: bigint): Promise<void> => {
      revoked.push(userId);
      return Promise.resolve();
    },
    clearPermissions: (userIds: readonly bigint[]): Promise<void> => {
      cleared.push([...userIds]);
      return Promise.resolve();
    },
  } as unknown as SessionStore;

  const dataScope = {
    resolve: (
      actor: {
        userId: bigint;
        isSuperAdmin: boolean;
        deptId: bigint | null;
      },
      ceiling: DataScopeCeiling,
    ): Promise<DataScopeFilter> => {
      scopeArgs.push({ actor, ceiling });
      const override = dataScopeOverrides.resolve;
      return Promise.resolve(
        override ? override(actor, ceiling) : { kind: 'all' },
      );
    },
    assertDeptVisible: (filter: DataScopeFilter, deptId: bigint): void => {
      assertArgs.push({ filter, deptId });
      dataScopeOverrides.assertDeptVisible?.(filter, deptId);
    },
  } as unknown as DataScopeService;

  return {
    service: new UserService(repository, roles, depts, sessions, dataScope),
    revoked,
    cleared,
    calls,
    replaceArgs,
    findManyArgs,
    createArgs,
    boundRoleIds,
    scopeArgs,
    assertArgs,
  };
}

// ── 受限建号（Ruling 28 / 计划 §3）────────────────────────────────────────
describe('UserService.createAccount', () => {
  it('1. 正常建号（给定 password）：落库 bcrypt 化、status=1、isSuperAdmin=false，绑 N 个角色，响应无 password', async () => {
    const { service, createArgs, boundRoleIds } = buildService();

    const result = await service.createAccount(
      accountDto({ password: 'Passw0rd!' }),
      caller().userId,
    );

    expect(createArgs).toHaveLength(1);
    // 显式字段映射（DTO-12）：只落这 8 个键，一个不多
    expect(Object.keys(createArgs[0]).sort()).toEqual([
      'deptId',
      'employeeNo',
      'isSuperAdmin',
      'mobile',
      'password',
      'realName',
      'status',
      'username',
    ]);
    expect(createArgs[0].status).toBe(1);
    expect(createArgs[0].isSuperAdmin).toBe(false);
    expect(createArgs[0].mobile).toBeNull();
    expect(createArgs[0].deptId).toBe(1n);
    // 2b：落库值 = hashSync(给定值, BCRYPT_ROUNDS)，不是明文
    expect(compareSync('Passw0rd!', createArgs[0].password as string)).toBe(
      true,
    );
    expect(createArgs[0].password).not.toBe('Passw0rd!');
    // 轮数就写在哈希里（$2b$10$… 的 10），反读出来跟常量对——
    // 光断 compareSync 不够：轮数被改成 4 照样校验通过，而那是一次静默降级。
    // 与 auth.constants.ts 的 DUMMY_PASSWORD_HASH 同一口径（getRounds === BCRYPT_ROUNDS）。
    expect(getRounds(createArgs[0].password as string)).toBe(BCRYPT_ROUNDS);

    // 判据 2：SysUserRole 落 N 行 = 去重后 roleIds 长度（建号只加不减）
    expect(boundRoleIds).toEqual([2n, 3n]);

    // RES-04：响应体里没有 password
    expect(result.roleIds).toEqual(['2', '3']);
    expect('password' in result).toBe(false);
  });

  it('2. 不给 password：随机生成并 bcrypt 落库（不是明文、不回显），响应同样无 password', async () => {
    const { service, createArgs } = buildService();

    const result = await service.createAccount(accountDto(), caller().userId);

    const stored = createArgs[0].password as string;
    expect(stored).toMatch(/^\$2/); // bcrypt 形态，不是明文
    // 随机口令走的是同一条 bcrypt 路径，轮数同样要点名
    expect(getRounds(stored)).toBe(BCRYPT_ROUNDS);
    // 随机生成的口令不留原文：入参里没有 password，落库的只有哈希
    expect(accountDto().password).toBeUndefined();
    expect('password' in result).toBe(false);
  });

  it('3. roleIds 去重后为空 → 400 / 10001，且不落库（比不建更坏，直接拒）', async () => {
    const { service, createArgs } = buildService();

    const result = service.createAccount(
      accountDto({ roleIds: [] }),
      caller().userId,
    );

    await expect(result).rejects.toMatchObject({
      response: { code: ErrorCode.PARAM_INVALID },
    });
    expect(createArgs).toHaveLength(0);
  });

  it('4. roleIds 含不存在的角色 → 404 / 22101，且一行都没写（createWithRoles 没被调用）', async () => {
    const { service, createArgs } = buildService(
      {},
      {
        assertExists: (id: bigint): Promise<void> => {
          if (id === 999n) {
            return Promise.reject(
              new BusinessException(
                ErrorCode.ROLE_NOT_FOUND,
                '角色不存在',
                HttpStatus.NOT_FOUND,
              ),
            );
          }
          return Promise.resolve();
        },
      },
    );

    const result = service.createAccount(
      accountDto({ roleIds: ['1', '999'] }),
      caller().userId,
    );

    await expect(result).rejects.toMatchObject({
      response: { code: ErrorCode.ROLE_NOT_FOUND },
    });
    // 预检在建号之前：一行都不该写下去
    expect(createArgs).toHaveLength(0);
  });

  it('5. roleIds 有重复 → 去重后绑角色（N = 去重后长度）', async () => {
    const { service, boundRoleIds } = buildService();

    await service.createAccount(
      accountDto({ roleIds: ['2', '2', '3'] }),
      caller().userId,
    );

    expect(boundRoleIds).toEqual([2n, 3n]);
  });

  it('6. username 撞库 → 409 / 21102，不落库', async () => {
    const { service, createArgs } = buildService({
      existsByUsername: (): Promise<boolean> => Promise.resolve(true),
    });

    const result = service.createAccount(accountDto(), caller().userId);

    await expect(result).rejects.toMatchObject({
      response: { code: ErrorCode.USER_NAME_TAKEN },
    });
    expect(createArgs).toHaveLength(0);
  });

  it('7. employeeNo 撞库 → 409 / 21103，不落库', async () => {
    const { service, createArgs } = buildService({
      existsByEmployeeNo: (): Promise<boolean> => Promise.resolve(true),
    });

    const result = service.createAccount(accountDto(), caller().userId);

    await expect(result).rejects.toMatchObject({
      response: { code: ErrorCode.USER_EMPLOYEE_NO_TAKEN },
    });
    expect(createArgs).toHaveLength(0);
  });

  it('8. deptId 不存在 → 400 / 10001（不是 24101），不落库', async () => {
    const { service, createArgs } = buildService(
      {},
      {},
      {
        exists: (): Promise<boolean> => Promise.resolve(false),
      },
    );

    const result = service.createAccount(accountDto(), caller().userId);

    await expect(result).rejects.toMatchObject({
      response: { code: ErrorCode.PARAM_INVALID },
    });
    expect(createArgs).toHaveLength(0);
  });

  it('9. 并发撞 P2002 且反查 username 被占 → 21102（快路径预检放行，反查才命中）', async () => {
    let usernameChecks = 0;
    const { service } = buildService({
      existsByUsername: (): Promise<boolean> => {
        usernameChecks += 1;
        return Promise.resolve(usernameChecks > 1);
      },
      createWithRoles: (): Promise<UserWithDeptName> =>
        Promise.reject(
          new Prisma.PrismaClientKnownRequestError('Unique constraint', {
            code: 'P2002',
            clientVersion: '6.19.3',
          }),
        ),
    });

    const result = service.createAccount(accountDto(), caller().userId);

    await expect(result).rejects.toMatchObject({
      response: { code: ErrorCode.USER_NAME_TAKEN },
    });
    expect(usernameChecks).toBeGreaterThan(1);
  });

  it('10. 并发撞 P2002 但反查都查不到（对方刚删掉）→ 通用 10006', async () => {
    const { service } = buildService({
      createWithRoles: (): Promise<UserWithDeptName> =>
        Promise.reject(
          new Prisma.PrismaClientKnownRequestError('Unique constraint', {
            code: 'P2002',
            clientVersion: '6.19.3',
          }),
        ),
    });

    const result = service.createAccount(accountDto(), caller().userId);

    await expect(result).rejects.toMatchObject({
      response: { code: ErrorCode.CONFLICT },
    });
  });
});

// ── 登录态与角色绑定（6b 后剩下的写面）───────────────────────────────────
describe('UserService', () => {
  it('11. updateStatus 目标是超管 → 21105；1→0 → revokeSessions；0→1 → 不调；同值 → 不调', async () => {
    // 目标是超管
    const protectedOne = buildService({
      findByIdWithDept: (): Promise<UserWithDeptName | null> =>
        Promise.resolve(user(9n, { isSuperAdmin: true })),
    });
    await expect(
      protectedOne.service.updateStatus(9n, { status: 0 }),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.USER_SUPER_ADMIN_PROTECTED },
    });

    // 1→0：作废
    const disabling = buildService({
      findByIdWithDept: (): Promise<UserWithDeptName | null> =>
        Promise.resolve(user(9n, { status: 1 })),
      update: (): Promise<UserWithDeptName> =>
        Promise.resolve(user(9n, { status: 0 })),
    });
    await disabling.service.updateStatus(9n, { status: 0 });
    expect(disabling.revoked).toEqual([9n]);

    // 0→1：不作废（启用不是「让人不能再访问」）
    const enabling = buildService({
      findByIdWithDept: (): Promise<UserWithDeptName | null> =>
        Promise.resolve(user(9n, { status: 0 })),
      update: (): Promise<UserWithDeptName> =>
        Promise.resolve(user(9n, { status: 1 })),
    });
    await enabling.service.updateStatus(9n, { status: 1 });
    expect(enabling.revoked).toHaveLength(0);

    // 同值：不作废
    const same = buildService({
      findByIdWithDept: (): Promise<UserWithDeptName | null> =>
        Promise.resolve(user(9n, { status: 1 })),
      update: (): Promise<UserWithDeptName> =>
        Promise.resolve(user(9n, { status: 1 })),
    });
    await same.service.updateStatus(9n, { status: 1 });
    expect(same.revoked).toHaveLength(0);
  });

  it('12. resetPassword 调用者非超管 + 目标是超管 → 403 / 10003（R21）；否则 updatePassword + revokeSessions', async () => {
    // R21：非超管动超管密码
    const r21 = buildService({
      findByIdWithDept: (): Promise<UserWithDeptName | null> =>
        Promise.resolve(user(9n, { isSuperAdmin: true })),
    });
    await expect(
      r21.service.resetPassword(
        9n,
        { password: 'NewPass1!' },
        caller({ isSuperAdmin: false }),
      ),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.FORBIDDEN },
    });

    // 正常路径
    const { service, revoked, calls } = buildService({
      findByIdWithDept: (): Promise<UserWithDeptName | null> =>
        Promise.resolve(user(9n)),
    });
    await service.resetPassword(9n, { password: 'NewPass1!' }, caller());
    expect(calls.some((call) => call.name === 'updatePassword')).toBe(true);
    expect(revoked).toEqual([9n]);
  });

  it('13. assignRoles 的差集：库里 [1,2]、目标 [2,3] → replaceUserRoles 收到 toAdd=[3n]、toRemove=[1n]，且 clearPermissions 收到 [id]（R10 ③）', async () => {
    const { service, replaceArgs, cleared } = buildService(
      {
        findByIdWithDept: (): Promise<UserWithDeptName | null> =>
          Promise.resolve(user(9n)),
      },
      {
        findRoleIdsByUserId: (): Promise<bigint[]> => Promise.resolve([1n, 2n]),
      },
    );

    await service.assignRoles(9n, { roleIds: ['2', '3'] });

    expect(replaceArgs).toHaveLength(1);
    expect(replaceArgs[0].toAdd).toEqual([3n]);
    expect(replaceArgs[0].toRemove).toEqual([1n]);
    expect(cleared).toEqual([[9n]]);
  });

  it('14. assignRoles 目标含不存在的角色 → 桩 RoleService.assertExists 抛 22101，且 replaceUserRoles 没被调用', async () => {
    const { service, replaceArgs } = buildService(
      {
        findByIdWithDept: (): Promise<UserWithDeptName | null> =>
          Promise.resolve(user(9n)),
      },
      {
        assertExists: (id: bigint): Promise<void> => {
          if (id === 999n) {
            return Promise.reject(
              new BusinessException(
                ErrorCode.ROLE_NOT_FOUND,
                '角色不存在',
                HttpStatus.NOT_FOUND,
              ),
            );
          }
          return Promise.resolve();
        },
        findRoleIdsByUserId: (): Promise<bigint[]> => Promise.resolve([]),
      },
    );

    const result = service.assignRoles(9n, { roleIds: ['1', '999'] });

    await expect(result).rejects.toMatchObject({
      response: { code: ErrorCode.ROLE_NOT_FOUND },
    });
    expect(replaceArgs).toHaveLength(0);
  });

  it('15. findPage 带 roleId → 把 roles.findUserIdsByRoleId 的结果传进 repository 的 userIds', async () => {
    const { service, findManyArgs } = buildService(
      {},
      {
        findUserIdsByRoleId: (): Promise<bigint[]> => Promise.resolve([5n, 6n]),
      },
    );

    await service.findPage({ page: 1, pageSize: 20, roleId: '3' }, caller());

    expect(findManyArgs).toHaveLength(1);
    expect(findManyArgs[0].userIds).toEqual([5n, 6n]);
  });

  it('15b. findPage 把数据范围交给 repository：deptId 来自库而不是令牌，上限来自 currentDataScopeCeiling()', async () => {
    // 令牌里没有部门。部门随调岗变化，写进 JWT 就得等令牌过期才生效——
    // 所以这里必须是「现查」，用 findById 的返回值验它。
    // 上限（ceiling）是 @DataScope 声明、拦截器写进上下文的那个值，
    // 这里用 'dept'（三个值里最不像默认值的）验证它真的被转发了。
    const { service, findManyArgs, scopeArgs } = buildService(
      {
        findById: (): Promise<SysUser | null> =>
          Promise.resolve(user(7n, { deptId: 42n })),
      },
      {},
      {},
      {
        resolve: (actor) => ({ kind: 'depts', deptIds: [actor.deptId ?? 0n] }),
      },
    );

    await requestContext.run(
      { traceId: 'test-15b', dataScopeCeiling: 'dept' },
      () =>
        service.findPage(
          { page: 1, pageSize: 20 },
          caller({ isSuperAdmin: false, userId: 7n }),
        ),
    );

    expect(scopeArgs).toEqual([
      {
        actor: { userId: 7n, isSuperAdmin: false, deptId: 42n },
        ceiling: 'dept',
      },
    ]);
    expect(findManyArgs[0].scope).toEqual({ kind: 'depts', deptIds: [42n] });
  });

  it('15c. findPage 把 deptId / roleId / scope 三个条件各自独立地交给 repository', async () => {
    const { service, findManyArgs, assertArgs } = buildService(
      {
        findById: (): Promise<SysUser | null> =>
          Promise.resolve(user(7n, { deptId: 42n })),
      },
      { findUserIdsByRoleId: (): Promise<bigint[]> => Promise.resolve([5n]) },
      {},
      { resolve: () => ({ kind: 'depts', deptIds: [42n, 43n] }) },
    );

    await requestContext.run(
      { traceId: 'test-15c', dataScopeCeiling: 'all' },
      () =>
        service.findPage(
          { page: 1, pageSize: 20, deptId: '42', roleId: '3' },
          caller({ isSuperAdmin: false, userId: 7n }),
        ),
    );

    expect(findManyArgs[0]).toMatchObject({
      deptId: 42n,
      userIds: [5n],
      scope: { kind: 'depts', deptIds: [42n, 43n] },
    });
    // 越权校验在查列表之前跑了，且拿的就是刚算出来的 filter
    expect(assertArgs).toEqual([
      { filter: { kind: 'depts', deptIds: [42n, 43n] }, deptId: 42n },
    ]);
  });

  it('15d. findPage 越权（assertDeptVisible 抛 403）→ 异常原样抛出，一个列表查询都不发', async () => {
    const { service, findManyArgs, assertArgs } = buildService(
      {
        findById: (): Promise<SysUser | null> =>
          Promise.resolve(user(7n, { deptId: 42n })),
      },
      {
        findUserIdsByRoleId: (): Promise<bigint[]> => {
          throw new Error('越权时连 roleId 的查询都不该发');
        },
      },
      {},
      {
        resolve: () => ({ kind: 'depts', deptIds: [42n] }),
        assertDeptVisible: () => {
          throw new BusinessException(
            ErrorCode.FORBIDDEN,
            '无权限',
            HttpStatus.FORBIDDEN,
          );
        },
      },
    );

    await expect(
      service.findPage(
        { page: 1, pageSize: 20, deptId: '99' },
        caller({ isSuperAdmin: false, userId: 7n }),
      ),
    ).rejects.toMatchObject({ response: { code: ErrorCode.FORBIDDEN } });

    expect(assertArgs).toEqual([
      { filter: { kind: 'depts', deptIds: [42n] }, deptId: 99n },
    ]);
    expect(findManyArgs).toHaveLength(0);
  });
});

// ── R14 次序：先作废再落库（invocationCallOrder）────────────────────────
describe('R14 先作废再落库', () => {
  function makeService(overrides: {
    repository?: Record<string, unknown>;
    sessions?: Record<string, unknown>;
  }): UserService {
    const repository = {
      findByIdWithDept: (): Promise<UserWithDeptName | null> =>
        Promise.resolve(user(9n)),
      existsByUsername: (): Promise<boolean> => Promise.resolve(false),
      existsByEmployeeNo: (): Promise<boolean> => Promise.resolve(false),
      updatePassword: (): Promise<UserWithDeptName> =>
        Promise.resolve(user(9n)),
      update: (): Promise<UserWithDeptName> => Promise.resolve(user(9n)),
      ...overrides.repository,
    } as unknown as UserRepository;
    const roles = {
      findRoleIdsByUserId: (): Promise<bigint[]> => Promise.resolve([]),
      findUserIdsByRoleId: (): Promise<bigint[]> => Promise.resolve([]),
    } as unknown as RoleService;
    const depts = {
      exists: (): Promise<boolean> => Promise.resolve(true),
    } as unknown as DeptService;
    const sessions = {
      revokeSessions: (): Promise<void> => Promise.resolve(),
      clearPermissions: (): Promise<void> => Promise.resolve(),
      ...overrides.sessions,
    } as unknown as SessionStore;
    const dataScope = {
      resolve: (): Promise<DataScopeFilter> => Promise.resolve({ kind: 'all' }),
    } as unknown as DataScopeService;
    return new UserService(repository, roles, depts, sessions, dataScope);
  }

  it('① 自己改密：revokeSessions 先于 updatePassword', async () => {
    const updatePassword = jest.fn().mockResolvedValue(user(9n));
    const revokeSessions = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      repository: { updatePassword },
      sessions: { revokeSessions },
    });

    await service.changeOwnPassword(9n, 'hash');

    expect(revokeSessions.mock.invocationCallOrder[0]).toBeLessThan(
      updatePassword.mock.invocationCallOrder[0],
    );
  });

  it('⑤ 管理员重置密码：revokeSessions 先于 updatePassword', async () => {
    const updatePassword = jest.fn().mockResolvedValue(user(9n));
    const revokeSessions = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      repository: { updatePassword },
      sessions: { revokeSessions },
    });

    await service.resetPassword(9n, { password: 'NewPass1!' }, caller());

    expect(revokeSessions.mock.invocationCallOrder[0]).toBeLessThan(
      updatePassword.mock.invocationCallOrder[0],
    );
  });

  it('⑥ 停用（applyStatusChange）：revokeSessions 先于 repository.update（钉住别被改回去）', async () => {
    const update = jest.fn().mockResolvedValue(user(9n, { status: 0 }));
    const revokeSessions = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      repository: {
        findByIdWithDept: (): Promise<UserWithDeptName | null> =>
          Promise.resolve(user(9n, { status: 1 })),
        update,
      },
      sessions: { revokeSessions },
    });

    await service.updateStatus(9n, { status: 0 });

    expect(revokeSessions.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0],
    );
  });
});
