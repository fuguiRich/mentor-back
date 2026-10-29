import type { SysDept } from '@prisma/client';
import { ErrorCode } from '../../common/constants/error-code';
import { BusinessException } from '../../common/errors/business.exception';
import { DeptRepository } from './dept.repository';
import { DeptService } from './dept.service';

/**
 * 环上的行必须是**完整**的 SysDept 实体：findTree 会先把每一行映射成
 * 响应 DTO（读 createdAt.toISOString()、createdBy.toString()），残缺的
 * 桩对象会在环检测之前就抛 TypeError——那样测到的是 mapper 的崩溃，
 * 而不是本用例想钉的「环检测」。
 */
function dept(id: bigint, parentId: bigint | null): SysDept {
  return {
    id,
    parentId,
    name: `部门 ${id.toString()}`,
    sortOrder: 0,
    status: 1,
    remark: null,
    createdAt: new Date('2026-10-14T00:00:00.000Z'),
    updatedAt: new Date('2026-10-14T00:00:00.000Z'),
    createdBy: 0n,
    updatedBy: 0n,
    deletedAt: null,
    deletedBy: null,
  };
}

function buildService(rows: SysDept[]): DeptService {
  const repository = {
    findMany: (): Promise<SysDept[]> => Promise.resolve(rows),
  } as unknown as DeptRepository;

  return new DeptService(repository);
}

describe('DeptService.findTree', () => {
  it('① 全环：整张图都在环里 → 抛 BusinessException，而不是静默返回空树', async () => {
    const service = buildService([dept(1n, 2n), dept(2n, 1n)]);

    const result = service.findTree();

    await expect(result).rejects.toThrow(BusinessException);
    await expect(result).rejects.toMatchObject({
      response: {
        code: ErrorCode.INTERNAL_ERROR,
        message: '部门数据存在环，无法构建部门树',
      },
    });
  });

  it('② 正常根 + 一截游离的环：旧判据（只数根）会放行，必须抛', async () => {
    const service = buildService([
      dept(1n, null), // 正常根
      dept(2n, 3n), // 游离环 A ↔ B
      dept(3n, 2n),
    ]);

    const result = service.findTree();

    await expect(result).rejects.toThrow(BusinessException);
    await expect(result).rejects.toMatchObject({
      response: {
        code: ErrorCode.INTERNAL_ERROR,
        message: '部门数据存在环，无法构建部门树',
      },
    });
  });

  it('③ 正常多层树：全部从根可达 → 不抛，且结构正确', async () => {
    const service = buildService([
      dept(1n, null), // 根
      dept(2n, 1n), // 子
      dept(3n, 2n), // 孙
    ]);

    const tree = await service.findTree();

    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({
      id: '1',
      parentId: null,
      children: [
        {
          id: '2',
          parentId: '1',
          children: [{ id: '3', parentId: '2', children: [] }],
        },
      ],
    });
  });

  it('④ 孤儿提升：父不在结果集里 → 提升为根、连带子树从根可达，不抛', async () => {
    const service = buildService([
      dept(2n, 99n), // 父 99 不在结果集里 → 提升为根
      dept(3n, 2n), // 孤儿自己的孩子
    ]);

    const tree = await service.findTree();

    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({
      id: '2',
      parentId: '99',
      children: [{ id: '3', parentId: '2', children: [] }],
    });
  });
});

// ── 6b 收口后的新增读口（createAccount 校验 deptId 用）────────────────────
describe('DeptService.exists', () => {
  function buildExistsService(found: SysDept | null): {
    service: DeptService;
    seenIds: bigint[];
  } {
    const seenIds: bigint[] = [];
    const repository = {
      findById: (id: bigint): Promise<SysDept | null> => {
        seenIds.push(id);
        return Promise.resolve(found);
      },
    } as unknown as DeptRepository;
    return { service: new DeptService(repository), seenIds };
  }

  it('① 存在（未软删）→ true，按传入的 id 查', async () => {
    const { service, seenIds } = buildExistsService(dept(7n, null));

    await expect(service.exists(7n)).resolves.toBe(true);
    expect(seenIds).toEqual([7n]);
  });

  it('② 不存在 / 已软删（findById 过滤后为 null）→ false，不抛 24101', async () => {
    const { service } = buildExistsService(null);

    await expect(service.exists(7n)).resolves.toBe(false);
  });
});

describe('DeptService.findOne', () => {
  it('找不到 → 24101（「部门不存在」只此一处定义）', async () => {
    const repository = {
      findById: (): Promise<SysDept | null> => Promise.resolve(null),
    } as unknown as DeptRepository;
    const service = new DeptService(repository);

    const result = service.findOne(404n);

    await expect(result).rejects.toMatchObject({
      response: {
        code: ErrorCode.DEPT_NOT_FOUND,
        message: '部门不存在',
      },
    });
  });
});
