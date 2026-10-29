import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../../common/constants/error-code';
import { BusinessException } from '../../common/errors/business.exception';
import type { DeptRepository } from '../dept/dept.repository';
import type { RoleRepository } from '../role/role.repository';
import { DataScopeService } from './data-scope.service';

function build(
  options: {
    roleIds?: bigint[];
    scopes?: string[];
    descendants?: bigint[];
  } = {},
): {
  service: DataScopeService;
  calls: string[];
} {
  const calls: string[] = [];

  const roles = {
    findRoleIdsByUserId: (userId: bigint): Promise<bigint[]> => {
      calls.push(`findRoleIdsByUserId(${userId.toString()})`);
      return Promise.resolve(options.roleIds ?? []);
    },
    findDataScopesByRoleIds: (roleIds: bigint[]): Promise<string[]> => {
      calls.push(`findDataScopesByRoleIds(${roleIds.length})`);
      return Promise.resolve(options.scopes ?? []);
    },
  } as unknown as RoleRepository;

  const depts = {
    findDescendantIds: (id: bigint): Promise<bigint[]> => {
      calls.push(`findDescendantIds(${id.toString()})`);
      return Promise.resolve(options.descendants ?? []);
    },
  } as unknown as DeptRepository;

  return { service: new DataScopeService(roles, depts), calls };
}

describe('DataScopeService.resolve', () => {
  it('1. 超管 + 上限 all → all，且不查角色表（少两次往返，也少一处会失败的路径）', async () => {
    const { service, calls } = build();

    await expect(
      service.resolve({ userId: 1n, isSuperAdmin: true, deptId: 9n }, 'all'),
    ).resolves.toEqual({ kind: 'all' });
    expect(calls).toEqual([]);
  });

  it('2. 没有任何角色 → self（默认往紧取，不是 all）', async () => {
    const { service } = build({ roleIds: [] });

    await expect(
      service.resolve({ userId: 2n, isSuperAdmin: false, deptId: 9n }, 'all'),
    ).resolves.toEqual({ kind: 'self', userId: 2n });
  });

  it('3. 多角色取最宽：self + deptAndChildren → deptAndChildren', async () => {
    const { service } = build({
      roleIds: [1n, 2n],
      scopes: ['self', 'deptAndChildren'],
      descendants: [11n, 12n],
    });

    await expect(
      service.resolve({ userId: 2n, isSuperAdmin: false, deptId: 9n }, 'all'),
    ).resolves.toEqual({ kind: 'depts', deptIds: [9n, 11n, 12n] });
  });

  it('4. 多角色取最窄会让人「多授一个角色反而看得更少」，所以这条必须是红的', async () => {
    const { service } = build({
      roleIds: [1n, 2n],
      // 只要有一个 all，结果就必须是 all——反过来的实现会在这里红
      scopes: ['self', 'all'],
    });

    await expect(
      service.resolve({ userId: 2n, isSuperAdmin: false, deptId: 9n }, 'all'),
    ).resolves.toEqual({ kind: 'all' });
  });

  it('5. dept + 有部门 → 只含本部门，不展开子树', async () => {
    const { service, calls } = build({ scopes: ['dept'], descendants: [11n] });

    await expect(
      service.resolve({ userId: 2n, isSuperAdmin: false, deptId: 9n }, 'all'),
    ).resolves.toEqual({ kind: 'depts', deptIds: [9n] });
    // dept 不该去查子树——查了就说明分支串了
    // （调用记录是 findDescendantIds(9)——id.toString() 不带 n 后缀）
    expect(calls).not.toContain('findDescendantIds(9)');
  });

  it('6. deptAndChildren + 有部门 → 本部门 + 全部后代', async () => {
    const { service } = build({
      scopes: ['deptAndChildren'],
      descendants: [11n, 12n],
    });

    await expect(
      service.resolve({ userId: 2n, isSuperAdmin: false, deptId: 9n }, 'all'),
    ).resolves.toEqual({ kind: 'depts', deptIds: [9n, 11n, 12n] });
  });

  it('7. 部门级范围但没有部门 → 空部门集（一行都看不见），不是 all', async () => {
    // 这是 fail-closed 的那一步：往松取的方向，一次配置错误就等于把全校数据
    // 交出去，而且没有任何机制会报警。所以它必须红得出来。
    const { service, calls } = build({
      scopes: ['deptAndChildren'],
      descendants: [11n],
    });

    await expect(
      service.resolve({ userId: 2n, isSuperAdmin: false, deptId: null }, 'all'),
    ).resolves.toEqual({ kind: 'depts', deptIds: [] });
    // 无部门就不必展开子树
    expect(calls).not.toContain('findDescendantIds(9)');
  });

  it('8. 库里的 data_scope 是脏字符串 → 按没有这个范围处理，不抛', async () => {
    // 数据是外部同步来的，脏值迟早会出现。抛异常会让整个列表接口 500，
    // 而正确行为是「这个角色贡献不了范围」——最终仍按最宽 / 最窄的既有规则算。
    const { service } = build({ roleIds: [1n], scopes: ['BROKEN', 'dept'] });

    await expect(
      service.resolve({ userId: 2n, isSuperAdmin: false, deptId: 9n }, 'all'),
    ).resolves.toEqual({ kind: 'depts', deptIds: [9n] });
  });

  it('判据 8：ceiling=self → 恒 {self}，deptId 传 null 不炸，不查角色 / 不查部门', async () => {
    const { service, calls } = build({
      roleIds: [1n],
      scopes: ['all'],
      descendants: [11n],
    });

    await expect(
      service.resolve({ userId: 2n, isSuperAdmin: true, deptId: null }, 'self'),
    ).resolves.toEqual({ kind: 'self', userId: 2n });
    // 上限 self 时根本不需部门，也不看 isSuperAdmin——mock 断言零调用
    expect(calls).toEqual([]);
  });

  it('判据 9：ceiling=dept + 超管 → 自己那棵子树（超管不豁免上限）', async () => {
    const { service, calls } = build({ descendants: [11n, 12n] });

    await expect(
      service.resolve({ userId: 1n, isSuperAdmin: true, deptId: 9n }, 'dept'),
    ).resolves.toEqual({ kind: 'depts', deptIds: [9n, 11n, 12n] });
    // 超管不查角色表（它的范围就是 all），但仍要展开子树
    expect(calls).not.toContain('findRoleIdsByUserId(1)');
    expect(calls).toContain('findDescendantIds(9)');
  });

  it('ceiling=dept + 超管 + 无部门 → 空部门集（超管也不豁免上限，更不豁免 fail-closed）', async () => {
    const { service } = build({ descendants: [11n] });

    await expect(
      service.resolve({ userId: 1n, isSuperAdmin: true, deptId: null }, 'dept'),
    ).resolves.toEqual({ kind: 'depts', deptIds: [] });
  });

  it('ceiling 与角色范围求窄：角色 all + 上限 dept → deptAndChildren，不是 all', async () => {
    const { service } = build({
      roleIds: [1n],
      scopes: ['all'],
      descendants: [11n],
    });

    await expect(
      service.resolve({ userId: 2n, isSuperAdmin: false, deptId: 9n }, 'dept'),
    ).resolves.toEqual({ kind: 'depts', deptIds: [9n, 11n] });
  });

  it('求窄保留更窄的角色范围：角色 dept + 上限 dept → 仍只含本部门，不被顶宽成 deptAndChildren', async () => {
    const { service, calls } = build({
      roleIds: [1n],
      scopes: ['dept'],
      descendants: [11n],
    });

    await expect(
      service.resolve({ userId: 2n, isSuperAdmin: false, deptId: 9n }, 'dept'),
    ).resolves.toEqual({ kind: 'depts', deptIds: [9n] });
    expect(calls).not.toContain('findDescendantIds(9)');
  });

  it('ceiling=all 与「没有上限」逐字相同：角色 deptAndChildren 不被压窄', async () => {
    const { service } = build({
      roleIds: [1n],
      scopes: ['deptAndChildren'],
      descendants: [11n, 12n],
    });

    await expect(
      service.resolve({ userId: 2n, isSuperAdmin: false, deptId: 9n }, 'all'),
    ).resolves.toEqual({ kind: 'depts', deptIds: [9n, 11n, 12n] });
  });
});

describe('DataScopeService.assertDeptVisible', () => {
  const service = build().service;

  function expectForbidden(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessException);
      expect(error).toMatchObject({
        response: { code: ErrorCode.FORBIDDEN },
        status: HttpStatus.FORBIDDEN,
      });
      return;
    }
    throw new Error('应当抛 10003 / 403，实际没有抛');
  }

  it("kind:'depts' 含目标部门 → 不抛", () => {
    expect(() =>
      service.assertDeptVisible({ kind: 'depts', deptIds: [3n, 7n] }, 7n),
    ).not.toThrow();
  });

  it("kind:'depts' 不含目标部门 → 403 / 10003（不是静默求交）", () => {
    expectForbidden(() =>
      service.assertDeptVisible({ kind: 'depts', deptIds: [3n] }, 7n),
    );
  });

  it("kind:'depts' 空数组 → 任何部门都 403", () => {
    expectForbidden(() =>
      service.assertDeptVisible({ kind: 'depts', deptIds: [] }, 1n),
    );
  });

  it("kind:'all' → 恒不抛", () => {
    expect(() =>
      service.assertDeptVisible({ kind: 'all' }, 999n),
    ).not.toThrow();
  });

  it("kind:'self' → 恒 403（self 过滤器没有部门维度，任何 deptId 都是越权）", () => {
    expectForbidden(() =>
      service.assertDeptVisible({ kind: 'self', userId: 2n }, 2n),
    );
  });

  it('抛的是 10003 / 403 —— 数据形状核对（响应体 data 为 null，不是空列表）', () => {
    try {
      service.assertDeptVisible({ kind: 'self', userId: 2n }, 1n);
      throw new Error('应当抛 10003 / 403，实际没有抛');
    } catch (error) {
      const exc = error as BusinessException;
      expect(exc.getStatus()).toBe(HttpStatus.FORBIDDEN);
      expect(exc.getResponse()).toEqual({
        code: ErrorCode.FORBIDDEN,
        message: '无权限',
        data: null,
      });
    }
  });
});
