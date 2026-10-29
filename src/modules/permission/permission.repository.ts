import { Injectable } from '@nestjs/common';
import type { SysPermission } from '@prisma/client';
import { currentActorId } from '../../common/context/request-context';
import { PrismaService } from '../../infra/prisma/prisma.service';

@Injectable()
export class PermissionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 某用户当前**生效**的权限码集合。
   *
   * 一处需要写明的越界：这张查询同时读了 role 模块的 `sys_user_role` /
   * `sys_role_permission`（spec 第 5 节的归属表把它们划给 role）。
   * 之所以放在权限模块而不是让 auth 拼接：它的结果就是"用户有哪些权限码"，
   * 是权限模块的领域概念；让 auth 去拼就要 auth → role 的额外依赖。
   * 只读、不写对方任何一张表。
   *
   * 两道过滤是**必须**的，且都不能省：
   *   ① 失效条件：角色停用（role.status）或权限点停用（permission.status）后，
   *      它带的权限码必须立刻不算数；
   *   ② 嵌套 `deletedAt: null` 要**手写**——Prisma 扩展的软删除过滤只改**顶层**
   *      `where`（`audit-args.util.ts` 的 withNotDeleted 直接覆盖 args.where），
   *      关系过滤器里的角色/权限点不会被自动过滤。漏了它，软删的角色照样发权限，
   *      而且是静默的。
   */
  async findCodesByUserId(userId: bigint): Promise<string[]> {
    const rows = await this.prisma.client.sysPermission.findMany({
      where: {
        code: { not: null },
        status: 1,
        rolePermissions: {
          some: {
            role: {
              status: 1,
              deletedAt: null,
              userRoles: { some: { userId } },
            },
          },
        },
      },
      select: { code: true },
      distinct: ['code'],
      orderBy: { code: 'asc' },
    });

    return rows.flatMap((row) => (row.code === null ? [] : [row.code]));
  }

  async findMany(): Promise<SysPermission[]> {
    return this.prisma.client.sysPermission.findMany({
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
  }

  /** 全部启用且未删的权限码。超管的 profile 用它当 permissions 集合 */
  async findAllCodes(): Promise<string[]> {
    // code: { not: null } 与 findCodesByUserId 的查询形状一致：DIR 节点没有码，
    // 漏了它这里会返回 (string | null)[]，且把「没有码」当成一个码发给前端
    const rows = await this.prisma.client.sysPermission.findMany({
      where: { code: { not: null }, deletedAt: null, status: 1 },
      select: { code: true },
    });

    return rows.flatMap((row) => (row.code === null ? [] : [row.code]));
  }

  async findById(id: bigint): Promise<SysPermission | null> {
    return this.prisma.client.sysPermission.findFirst({ where: { id } });
  }

  async countByParentId(parentId: bigint): Promise<number> {
    return this.prisma.client.sysPermission.count({ where: { parentId } });
  }

  /** 权限码全局唯一（uk_sys_permission.code_active），不按父节点分层 */
  async existsByCode(code: string, excludeId?: bigint): Promise<boolean> {
    const found = await this.prisma.client.sysPermission.findFirst({
      where: {
        code,
        ...(excludeId === undefined ? {} : { id: { not: excludeId } }),
      },
      select: { id: true },
    });

    return found !== null;
  }

  async create(data: {
    parentId: bigint | null;
    type: string;
    code: string | null;
    name: string;
    path: string | null;
    component: string | null;
    icon: string | null;
    sortOrder: number;
    status: number;
  }): Promise<SysPermission> {
    // createdBy / updatedBy 是**类型层面**的必需字段，运行时会被扩展先剥掉、
    // 再按当前操作者重写——这里填的 0n 只是占位，永远不会落库
    // （同 dept.repository.ts:30-34）。
    return this.prisma.client.sysPermission.create({
      data: { ...data, createdBy: 0n, updatedBy: 0n },
    });
  }

  async update(
    id: bigint,
    data: {
      parentId: bigint | null;
      type: string;
      code: string | null;
      name: string;
      path?: string | null;
      component?: string | null;
      icon?: string | null;
      sortOrder?: number;
      status?: number;
    },
  ): Promise<SysPermission> {
    return this.prisma.client.sysPermission.update({ where: { id }, data });
  }

  /**
   * R9：同一事务里物理清掉角色↔权限的连接行，再软删权限点本身。
   * 软删不触发外键级联（外键只对物理 DELETE 生效），不清连接行就会留下
   * 悬挂引用，接着任何「按权限查角色」的查询都会读到已删权限点。
   * 软删是**显式 update**（R24，取代 R19）：Prisma 6 的查询扩展回调拿不到
   * 发起查询的 client，「delete 改写成 update」的重派发会逃出事务，所以扩展
   * 现在对实体表的 delete 直接抛错、改写能力整个撤销。写成 update 之后，
   * 它天然跑在下面这个 $transaction 里，原子性由事务本身保证。
   * updatedAt/updatedBy 由扩展的 update 审计分支补上（DB-05/DB-06）。
   */
  async deleteWithRoleRefs(id: bigint): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      await tx.sysRolePermission.deleteMany({ where: { permissionId: id } });
      await tx.sysPermission.update({
        where: { id },
        data: { deletedAt: new Date(), deletedBy: currentActorId() },
      });
    });
  }

  /**
   * 持有「引用了该权限点的任一角色」的用户 ID 去重集合，供权限缓存清理
   * （裁决 R10 的 ④⑤）。跨模块读连接表的理由与 findCodesByUserId 相同，只读。
   * 不过滤 role.deletedAt：被软删角色的持有者多清一次缓存没有坏处，漏清才有。
   */
  async findUserIdsByPermissionId(permissionId: bigint): Promise<bigint[]> {
    const rows = await this.prisma.client.sysUserRole.findMany({
      where: {
        role: { rolePermissions: { some: { permissionId } } },
      },
      select: { userId: true },
      distinct: ['userId'],
    });

    return rows.map((row) => row.userId);
  }

  /** 沿 parentId 向上取祖先链，用于成环检测（同 dept.repository.ts） */
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
}
