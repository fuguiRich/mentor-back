import type { SysPermission } from '@prisma/client';
import { ErrorCode } from '../../common/constants/error-code';
import type { SessionStore } from '../../infra/redis/session-store.service';
import { PermissionRepository } from './permission.repository';
import { PermissionService } from './permission.service';

function permission(
  id: bigint,
  overrides: Partial<SysPermission> = {},
): SysPermission {
  return {
    id,
    parentId: null,
    type: 'MENU',
    code: `res:act${id.toString()}`,
    name: `权限点 ${id.toString()}`,
    path: null,
    component: null,
    icon: null,
    sortOrder: 0,
    status: 1,
    createdAt: new Date('2026-10-14T00:00:00.000Z'),
    updatedAt: new Date('2026-10-14T00:00:00.000Z'),
    createdBy: 0n,
    updatedBy: 0n,
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  };
}

/** 桩：所有方法默认「查无此物 / 空」，用例只覆写自己关心的那个 */
function buildService(
  overrides: Partial<Record<keyof PermissionRepository, unknown>> = {},
): {
  service: PermissionService;
  cleared: bigint[][];
} {
  const cleared: bigint[][] = [];
  const repository = {
    findCodesByUserId: (): Promise<string[]> => Promise.resolve([]),
    findMany: (): Promise<SysPermission[]> => Promise.resolve([]),
    findById: (): Promise<SysPermission | null> => Promise.resolve(null),
    countByParentId: (): Promise<number> => Promise.resolve(0),
    existsByCode: (): Promise<boolean> => Promise.resolve(false),
    findAncestorIds: (): Promise<bigint[]> => Promise.resolve([]),
    findUserIdsByPermissionId: (): Promise<bigint[]> => Promise.resolve([]),
    create: (): Promise<SysPermission> => Promise.resolve(permission(1n)),
    update: (): Promise<SysPermission> => Promise.resolve(permission(1n)),
    deleteWithRoleRefs: (): Promise<void> => Promise.resolve(),
    ...overrides,
  } as unknown as PermissionRepository;

  const sessions = {
    clearPermissions: (userIds: bigint[]): Promise<void> => {
      cleared.push(userIds);
      return Promise.resolve();
    },
  } as unknown as SessionStore;

  return { service: new PermissionService(repository, sessions), cleared };
}

describe('PermissionService 类型↔权限码约束（R8）', () => {
  it('1. create DIR 带 code → 23104', async () => {
    const { service } = buildService();

    const result = service.create({
      type: 'DIR',
      code: 'user:list',
      name: '用户管理',
    });

    await expect(result).rejects.toMatchObject({
      response: { code: ErrorCode.PERMISSION_CODE_FORBIDDEN },
    });
  });

  it('2. create MENU 不带 code → 23103', async () => {
    const { service } = buildService();

    const result = service.create({ type: 'MENU', name: '用户管理' });

    await expect(result).rejects.toMatchObject({
      response: { code: ErrorCode.PERMISSION_CODE_REQUIRED },
    });
  });

  it('3. create BUTTON 带 code → 成功，返回 type: BUTTON', async () => {
    const { service } = buildService({
      create: (): Promise<SysPermission> =>
        Promise.resolve(
          permission(1n, { type: 'BUTTON', code: 'user:create' }),
        ),
    });

    const created = await service.create({
      type: 'BUTTON',
      code: 'user:create',
      name: '新建用户',
    });

    expect(created).toMatchObject({ type: 'BUTTON', code: 'user:create' });
  });

  it('4. update 只改 type 为 DIR、不传 code（库里有码）→ 23104：按改完之后的形态判', async () => {
    const { service } = buildService({
      findById: (): Promise<SysPermission | null> =>
        Promise.resolve(permission(1n, { code: 'res:act1' })),
    });

    const result = service.update(1n, { name: '权限点 1', type: 'DIR' });

    await expect(result).rejects.toMatchObject({
      response: { code: ErrorCode.PERMISSION_CODE_FORBIDDEN },
    });
  });

  it('5. update type: DIR、code: null → 成功', async () => {
    const { service } = buildService({
      findById: (): Promise<SysPermission | null> =>
        Promise.resolve(permission(1n, { code: 'res:act1' })),
      update: (): Promise<SysPermission> =>
        Promise.resolve(permission(1n, { type: 'DIR', code: null })),
    });

    const updated = await service.update(1n, {
      name: '权限点 1',
      type: 'DIR',
      code: null,
    });

    expect(updated).toMatchObject({ type: 'DIR', code: null });
  });

  it('6. update 只改 type 为 MENU、库里 code 为 null → 23103', async () => {
    const { service } = buildService({
      findById: (): Promise<SysPermission | null> =>
        Promise.resolve(permission(1n, { type: 'DIR', code: null })),
    });

    const result = service.update(1n, { name: '权限点 1', type: 'MENU' });

    await expect(result).rejects.toMatchObject({
      response: { code: ErrorCode.PERMISSION_CODE_REQUIRED },
    });
  });
});

describe('PermissionService 权限码唯一与层级（R8 / 23102 / 23105 / 23106）', () => {
  it('7. create 时权限码已被占用 → 23102', async () => {
    const { service } = buildService({
      existsByCode: (): Promise<boolean> => Promise.resolve(true),
    });

    const result = service.create({
      type: 'MENU',
      code: 'user:list',
      name: '用户管理',
    });

    await expect(result).rejects.toMatchObject({
      response: { code: ErrorCode.PERMISSION_CODE_TAKEN },
    });
  });

  it('8. update parentId 指向自己或自己的下级 → 23105', async () => {
    const current = permission(1n);
    const { service } = buildService({
      findById: (): Promise<SysPermission | null> => Promise.resolve(current),
    });

    const selfResult = service.update(1n, {
      name: '权限点 1',
      parentId: '1',
    });
    await expect(selfResult).rejects.toMatchObject({
      response: {
        code: ErrorCode.PERMISSION_PARENT_INVALID,
        message: '上级权限点不能是自己',
      },
    });

    const { service: service2 } = buildService({
      findById: (): Promise<SysPermission | null> => Promise.resolve(current),
      findAncestorIds: (): Promise<bigint[]> => Promise.resolve([1n]),
    });

    const descendantResult = service2.update(1n, {
      name: '权限点 1',
      parentId: '2',
    });
    await expect(descendantResult).rejects.toMatchObject({
      response: {
        code: ErrorCode.PERMISSION_PARENT_INVALID,
        message: '上级权限点不能是自己的下级',
      },
    });
  });

  it('9. remove 有下级 → 23106', async () => {
    const { service } = buildService({
      findById: (): Promise<SysPermission | null> =>
        Promise.resolve(permission(1n)),
      countByParentId: (): Promise<number> => Promise.resolve(2),
    });

    const result = service.remove(1n);

    await expect(result).rejects.toMatchObject({
      response: { code: ErrorCode.PERMISSION_HAS_CHILDREN },
    });
  });
});

describe('PermissionService 删除与缓存清理（R9 / R10 ④⑤）', () => {
  it('10. remove 成功时清连接行，且 clearPermissions 拿到受影响用户', async () => {
    let deletedId: bigint | undefined;
    const { service, cleared } = buildService({
      findById: (): Promise<SysPermission | null> =>
        Promise.resolve(permission(1n)),
      findUserIdsByPermissionId: (): Promise<bigint[]> =>
        Promise.resolve([7n, 8n]),
      deleteWithRoleRefs: (id: bigint): Promise<void> => {
        deletedId = id;
        return Promise.resolve();
      },
    });

    await service.remove(1n);

    expect(deletedId).toBe(1n);
    expect(cleared).toEqual([[7n, 8n]]);
  });

  it('11. update 改 status 或 code 时清缓存；只改 name 时不清', async () => {
    const current = permission(1n, { code: 'res:act1', status: 1 });

    const statusCase = buildService({
      findById: (): Promise<SysPermission | null> => Promise.resolve(current),
      findUserIdsByPermissionId: (): Promise<bigint[]> => Promise.resolve([5n]),
    });
    await statusCase.service.update(1n, { name: '权限点 1', status: 0 });
    expect(statusCase.cleared).toEqual([[5n]]);

    const codeCase = buildService({
      findById: (): Promise<SysPermission | null> => Promise.resolve(current),
      findUserIdsByPermissionId: (): Promise<bigint[]> => Promise.resolve([6n]),
    });
    await codeCase.service.update(1n, { name: '权限点 1', code: 'res:new' });
    expect(codeCase.cleared).toEqual([[6n]]);

    const nameCase = buildService({
      findById: (): Promise<SysPermission | null> => Promise.resolve(current),
    });
    await nameCase.service.update(1n, { name: '只改名字' });
    expect(nameCase.cleared).toEqual([]);
  });
});

describe('PermissionService.findMenuTreeByCodes（侧边栏裁树）', () => {
  // 合成一棵小树，不走 DB：这个方法要钉的是「挂哪儿」，不是「查得到什么」。
  //
  //   A(1, MENU, menu:a, root)
  //   └─ B(2, BUTTON, btn:b)          ← 按钮，永远不入侧边栏
  //       └─ C(3, MENU, menu:c)
  //
  // 另有 D(4, MENU, menu:d, root) 作无关节点。
  function tree(): SysPermission[] {
    return [
      permission(1n, { parentId: null, type: 'MENU', code: 'menu:a' }),
      permission(2n, { parentId: 1n, type: 'BUTTON', code: 'btn:b' }),
      permission(3n, { parentId: 2n, type: 'MENU', code: 'menu:c' }),
      permission(4n, { parentId: null, type: 'MENU', code: 'menu:d' }),
    ];
  }

  it('12. BUTTON 的子节点挂到再上一层：只授 C 时是一个根 A 带子节点 C，不是 [A, C] 两个根', async () => {
    const { service } = buildService({
      findMany: (): Promise<SysPermission[]> => Promise.resolve(tree()),
    });

    const result = await service.findMenuTreeByCodes(['menu:c']);

    // 这是 27 的回归钉：不重写 parentId 的话 toPermissionTree 会把 C 提升成根
    expect(result).toHaveLength(1);
    expect(result[0].code).toBe('menu:a');
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].code).toBe('menu:c');
    // 深层也别再冒出第三个根
    expect(result[0].children[0].children).toEqual([]);
  });

  it('13. 空 codes → 空数组（树本身非空也一样）', async () => {
    const { service } = buildService({
      findMany: (): Promise<SysPermission[]> => Promise.resolve(tree()),
    });

    const result = await service.findMenuTreeByCodes([]);

    expect(result).toEqual([]);
  });

  it('14. 只授叶子时，未被授予的非 BUTTON 祖先仍作骨架留在树上', async () => {
    // E(5, MENU, menu:e, root) —— 没被授予
    // └─ F(6, MENU, menu:f)      —— 被授予
    const fixture = [
      permission(5n, { parentId: null, type: 'MENU', code: 'menu:e' }),
      permission(6n, { parentId: 5n, type: 'MENU', code: 'menu:f' }),
    ];
    const { service } = buildService({
      findMany: (): Promise<SysPermission[]> => Promise.resolve(fixture),
    });

    const result = await service.findMenuTreeByCodes(['menu:f']);

    expect(result).toHaveLength(1);
    expect(result[0].code).toBe('menu:e'); // 骨架：没被授予也留着
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].code).toBe('menu:f');
  });
});
