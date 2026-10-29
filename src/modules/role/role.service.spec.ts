import { HttpStatus } from '@nestjs/common';
import { Prisma, type SysRole } from '@prisma/client';
import { ErrorCode } from '../../common/constants/error-code';
import { BusinessException } from '../../common/errors/business.exception';
import type { SessionStore } from '../../infra/redis/session-store.service';
import type { PermissionService } from '../permission/permission.service';
import { RoleRepository } from './role.repository';
import { RoleService } from './role.service';
import type { AssignRolePermissionsDto } from './dto/assign-role-permissions.dto';

function role(id: bigint, overrides: Partial<SysRole> = {}): SysRole {
  return {
    id,
    name: `角色 ${id.toString()}`,
    code: `role_${id.toString()}`,
    dataScope: 'self',
    status: 1,
    remark: null,
    createdAt: new Date('2026-10-14T00:00:00.000Z'),
    updatedAt: new Date('2026-10-14T00:00:00.000Z'),
    createdBy: 0n,
    updatedBy: 0n,
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  };
}

/** 调用序列记录（case 7 要断言顺序） */
interface CallLog {
  name: string;
  args: unknown[];
}

function buildService(
  repositoryOverrides: Partial<Record<keyof RoleRepository, unknown>> = {},
  permissionOverrides: Partial<Record<'assertExists', unknown>> = {},
): {
  service: RoleService;
  cleared: bigint[][];
  calls: CallLog[];
  replaceArgs: { roleId: bigint; toAdd: bigint[]; toRemove: bigint[] }[];
  assertExistsIds: bigint[];
} {
  const cleared: bigint[][] = [];
  const calls: CallLog[] = [];
  const replaceArgs: { roleId: bigint; toAdd: bigint[]; toRemove: bigint[] }[] =
    [];
  const assertExistsIds: bigint[] = [];

  const repository = {
    findMany: (): Promise<{ rows: SysRole[]; total: number }> =>
      Promise.resolve({ rows: [], total: 0 }),
    findById: (): Promise<SysRole | null> => Promise.resolve(null),
    existsByCode: (): Promise<boolean> => Promise.resolve(false),
    create: (): Promise<SysRole> => Promise.resolve(role(1n)),
    update: (): Promise<SysRole> => Promise.resolve(role(1n)),
    deleteWithRefs: (): Promise<void> => {
      calls.push({ name: 'deleteWithRefs', args: [] });
      return Promise.resolve();
    },
    findUserIdsByRoleId: (): Promise<bigint[]> => {
      calls.push({ name: 'findUserIdsByRoleId', args: [] });
      return Promise.resolve([]);
    },
    findPermissionIdsByRoleId: (): Promise<bigint[]> => Promise.resolve([]),
    replacePermissions: (
      roleId: bigint,
      toAdd: bigint[],
      toRemove: bigint[],
    ): Promise<void> => {
      replaceArgs.push({ roleId, toAdd, toRemove });
      calls.push({
        name: 'replacePermissions',
        args: [roleId, toAdd, toRemove],
      });
      return Promise.resolve();
    },
    ...repositoryOverrides,
  } as unknown as RoleRepository;

  const permissions = {
    assertExists: (id: bigint): Promise<void> => {
      assertExistsIds.push(id);
      return Promise.resolve();
    },
    ...permissionOverrides,
  } as unknown as PermissionService;

  const sessions = {
    clearPermissions: (userIds: readonly bigint[]): Promise<void> => {
      cleared.push([...userIds]);
      return Promise.resolve();
    },
  } as unknown as SessionStore;

  return {
    service: new RoleService(repository, permissions, sessions),
    cleared,
    calls,
    replaceArgs,
    assertExistsIds,
  };
}

function assignDto(ids: string[]): AssignRolePermissionsDto {
  return { permissionIds: ids };
}

describe('RoleService', () => {
  it('1. create 时 existsByCode 为 true → 22102', async () => {
    const { service } = buildService({
      existsByCode: (): Promise<boolean> => Promise.resolve(true),
    });

    const result = service.create({
      name: '教务管理员',
      code: 'academic_admin',
    });

    await expect(result).rejects.toMatchObject({
      response: { code: ErrorCode.ROLE_CODE_TAKEN },
    });
  });

  it('2. create 撞 P2002 → 也回 22102', async () => {
    const { service } = buildService({
      create: (): Promise<SysRole> =>
        Promise.reject(
          new Prisma.PrismaClientKnownRequestError('Unique constraint', {
            code: 'P2002',
            clientVersion: '6.19.3',
          }),
        ),
    });

    const result = service.create({
      name: '教务管理员',
      code: 'academic_admin',
    });

    await expect(result).rejects.toMatchObject({
      response: { code: ErrorCode.ROLE_CODE_TAKEN },
    });
  });

  it('3. assignPermissions 的差集算得对：库里 [1,2]、目标 [2,3] → toAdd=[3n]、toRemove=[1n]', async () => {
    const { service, replaceArgs } = buildService({
      findById: (): Promise<SysRole | null> => Promise.resolve(role(9n)),
      findPermissionIdsByRoleId: (): Promise<bigint[]> =>
        Promise.resolve([1n, 2n]),
    });

    await service.assignPermissions(9n, assignDto(['2', '3']));

    expect(replaceArgs).toHaveLength(1);
    expect(replaceArgs[0].toAdd).toEqual([3n]);
    expect(replaceArgs[0].toRemove).toEqual([1n]);
  });

  it('4. assignPermissions 去重：目标 [1,1,2] → targetIds 只有两项', async () => {
    const { service, assertExistsIds, replaceArgs } = buildService({
      findById: (): Promise<SysRole | null> => Promise.resolve(role(9n)),
      findPermissionIdsByRoleId: (): Promise<bigint[]> => Promise.resolve([]),
    });

    await service.assignPermissions(9n, assignDto(['1', '1', '2']));

    // assertExists 只被调两次——重复 ID 在进校验循环前就被去重了
    expect(assertExistsIds).toEqual([1n, 2n]);
    expect(replaceArgs[0].toAdd).toEqual([1n, 2n]);
  });

  it('5. assignPermissions 目标为空数组 → toRemove 是全部、toAdd 为空', async () => {
    const { service, replaceArgs } = buildService({
      findById: (): Promise<SysRole | null> => Promise.resolve(role(9n)),
      findPermissionIdsByRoleId: (): Promise<bigint[]> =>
        Promise.resolve([1n, 2n, 3n]),
    });

    await service.assignPermissions(9n, assignDto([]));

    expect(replaceArgs[0].toAdd).toEqual([]);
    expect(replaceArgs[0].toRemove).toEqual([1n, 2n, 3n]);
  });

  it('6. assignPermissions 有不存在的权限点 → 抛 23101，且 replacePermissions 没被调用', async () => {
    const { service, replaceArgs } = buildService(
      {
        findById: (): Promise<SysRole | null> => Promise.resolve(role(9n)),
        findPermissionIdsByRoleId: (): Promise<bigint[]> =>
          Promise.resolve([1n]),
      },
      {
        assertExists: (): Promise<void> =>
          Promise.reject(
            new BusinessException(
              ErrorCode.PERMISSION_NOT_FOUND,
              '权限点不存在',
              HttpStatus.NOT_FOUND,
            ),
          ),
      },
    );

    const result = service.assignPermissions(9n, assignDto(['1', '999']));

    await expect(result).rejects.toMatchObject({
      response: { code: ErrorCode.PERMISSION_NOT_FOUND },
    });
    expect(replaceArgs).toHaveLength(0);
  });

  it('7. remove 的顺序：findUserIdsByRoleId 在 deleteWithRefs 之前，且 clearPermissions 拿到那份用户列表', async () => {
    const { service, cleared, calls } = buildService({
      findById: (): Promise<SysRole | null> => Promise.resolve(role(9n)),
      findUserIdsByRoleId: (): Promise<bigint[]> => {
        calls.push({ name: 'findUserIdsByRoleId', args: [] });
        return Promise.resolve([10n, 20n]);
      },
    });

    await service.remove(9n);

    const names = calls.map((call) => call.name);
    const findIdx = names.indexOf('findUserIdsByRoleId');
    const deleteIdx = names.indexOf('deleteWithRefs');
    expect(findIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(findIdx);
    expect(cleared).toEqual([[10n, 20n]]);
  });

  it('8. updateStatus 同值 → clearPermissions 未被调用；异值 → 被调用', async () => {
    // 同值（当前 status=1，目标也是 1）
    const same = buildService({
      findById: (): Promise<SysRole | null> => Promise.resolve(role(9n)),
      update: (): Promise<SysRole> => Promise.resolve(role(9n)),
      findUserIdsByRoleId: (): Promise<bigint[]> => Promise.resolve([1n]),
    });
    await same.service.updateStatus(9n, { status: 1 });
    expect(same.cleared).toHaveLength(0);

    // 异值（当前 status=1，目标 0）
    const different = buildService({
      findById: (): Promise<SysRole | null> => Promise.resolve(role(9n)),
      update: (): Promise<SysRole> => Promise.resolve(role(9n, { status: 0 })),
      findUserIdsByRoleId: (): Promise<bigint[]> => Promise.resolve([1n]),
    });
    await different.service.updateStatus(9n, { status: 0 });
    expect(different.cleared).toEqual([[1n]]);
  });

  it('8b. update 改 status 也清缓存（R10 ②）：异值清、同值不清、不传 status 不清', async () => {
    // 分支 1：status 1→0 → 清缓存，且清的是该角色成员
    const changed = buildService({
      findById: (): Promise<SysRole | null> => Promise.resolve(role(9n)),
      update: (): Promise<SysRole> => Promise.resolve(role(9n, { status: 0 })),
      findUserIdsByRoleId: (): Promise<bigint[]> => Promise.resolve([10n, 20n]),
    });
    await changed.service.update(9n, {
      name: '改名',
      status: 0,
    });
    expect(changed.cleared).toEqual([[10n, 20n]]);

    // 分支 2：status 同值（当前 1 传 1）→ 不清
    const sameStatus = buildService({
      findById: (): Promise<SysRole | null> => Promise.resolve(role(9n)),
      update: (): Promise<SysRole> => Promise.resolve(role(9n)),
      findUserIdsByRoleId: (): Promise<bigint[]> => Promise.resolve([1n]),
    });
    await sameStatus.service.update(9n, {
      name: '改名',
      status: 1,
    });
    expect(sameStatus.cleared).toHaveLength(0);

    // 分支 3：不传 status（只改 name）→ 不清
    const noStatus = buildService({
      findById: (): Promise<SysRole | null> => Promise.resolve(role(9n)),
      update: (): Promise<SysRole> => Promise.resolve(role(9n)),
      findUserIdsByRoleId: (): Promise<bigint[]> => Promise.resolve([1n]),
    });
    await noStatus.service.update(9n, { name: '只改名' });
    expect(noStatus.cleared).toHaveLength(0);
  });

  it('9. findOne / update / remove 对不存在的 id → 22101', async () => {
    const { service } = buildService();

    await expect(service.findOne(404n)).rejects.toMatchObject({
      response: { code: ErrorCode.ROLE_NOT_FOUND },
    });
    await expect(
      service.update(404n, { name: '不存在' }),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.ROLE_NOT_FOUND },
    });
    await expect(service.remove(404n)).rejects.toMatchObject({
      response: { code: ErrorCode.ROLE_NOT_FOUND },
    });
  });
});
