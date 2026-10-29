import { Injectable } from '@nestjs/common';
import type { SysDept } from '@prisma/client';
import { currentActorId } from '../../common/context/request-context';
import { PrismaService } from '../../infra/prisma/prisma.service';

@Injectable()
export class DeptRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(name?: string): Promise<SysDept[]> {
    return this.prisma.client.sysDept.findMany({
      where: name === undefined ? {} : { name: { contains: name } },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
  }

  async findById(id: bigint): Promise<SysDept | null> {
    return this.prisma.client.sysDept.findFirst({ where: { id } });
  }

  async countByParentId(parentId: bigint): Promise<number> {
    return this.prisma.client.sysDept.count({ where: { parentId } });
  }

  async create(data: {
    parentId: bigint | null;
    name: string;
    sortOrder: number;
    status: number;
    remark?: string;
  }): Promise<SysDept> {
    // createdBy / updatedBy 是**类型层面**的必需字段（列 NOT NULL 且无默认值），
    // 但运行时会被任务 4 的扩展先剥掉、再按当前操作者重写——这里填的 0n 只是占位，
    // 永远不会落库。放在 repository 而不是 service，是为了不让占位值渗进业务代码
    // （LAYER-01 与「审计字段由扩展统一填充、Service 禁止手写赋值」）。
    return this.prisma.client.sysDept.create({
      data: { ...data, createdBy: 0n, updatedBy: 0n },
    });
  }

  async update(
    id: bigint,
    data: {
      parentId?: bigint | null;
      name?: string;
      sortOrder?: number;
      status?: number;
      remark?: string;
    },
  ): Promise<SysDept> {
    return this.prisma.client.sysDept.update({ where: { id }, data });
  }

  async softDelete(id: bigint): Promise<void> {
    // R24（取代 R19）：软删除是 repository 显式写 update，不再依赖扩展把
    // delete 改写成 update——Prisma 6 的查询扩展回调拿不到发起查询的 client，
    // 那个重派发会逃出事务（见 prisma.extension.ts），扩展现在对实体表的
    // delete 直接抛错。updatedAt/updatedBy 由扩展的 update 审计分支补上
    // （DB-05/DB-06），这里只写软删除标记本身。
    await this.prisma.client.sysDept.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: currentActorId() },
    });
  }

  async existsByParentAndName(
    parentId: bigint | null,
    name: string,
    excludeId?: bigint,
  ): Promise<boolean> {
    const found = await this.prisma.client.sysDept.findFirst({
      where: {
        parentId,
        name,
        ...(excludeId === undefined ? {} : { id: { not: excludeId } }),
      },
      select: { id: true },
    });

    return found !== null;
  }

  /**
   * 统计该部门下的未删除用户数。
   *
   * 这是「跨模块只读校验」的窄用途：dept 模块不拥有 sys_user、不修改它，
   * 只为删除安全做一次计数。除这类只读校验与 Prisma 关系包含外，
   * 不得跨模块读写对方的表。
   */
  async countUsers(deptId: bigint): Promise<number> {
    return this.prisma.client.sysUser.count({ where: { deptId } });
  }

  /** 沿 parentId 向上取祖先链，用于成环检测 */
  async findAncestorIds(id: bigint): Promise<bigint[]> {
    const ancestors: bigint[] = [];
    const seen = new Set<string>();
    let cursor: bigint | null = id;

    while (cursor !== null) {
      const key = cursor.toString();
      if (seen.has(key)) {
        break; // 数据里已有环，别在这里死循环
      }
      seen.add(key);

      const node = await this.findById(cursor);
      if (node === null || node.parentId === null) {
        break;
      }

      ancestors.push(node.parentId);
      cursor = node.parentId;
    }

    return ancestors;
  }

  /**
   * 沿 parentId 向下取整棵子树（不含自己），数据范围 `deptAndChildren` 用。
   * 逐层 BFS 而不是递归 CTE：层数就是树高，通常个位数；递归 CTE 在 MySQL 里
   * 要写原生 SQL，而这一条不值得为它撕开 Prisma 的类型边界。
   * `seen` 同样是防环——同一批数据里 `findAncestorIds` 已经认定可能有环。
   */
  async findDescendantIds(id: bigint): Promise<bigint[]> {
    const descendants: bigint[] = [];
    const seen = new Set<string>([id.toString()]);
    let frontier: bigint[] = [id];

    while (frontier.length > 0) {
      const children = await this.prisma.client.sysDept.findMany({
        where: { parentId: { in: frontier } },
        select: { id: true },
      });

      frontier = [];
      for (const child of children) {
        const key = child.id.toString();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        descendants.push(child.id);
        frontier.push(child.id);
      }
    }

    return descendants;
  }
}
