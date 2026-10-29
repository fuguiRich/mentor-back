import { Injectable } from '@nestjs/common';
import type { SysRole } from '@prisma/client';
import { currentActorId } from '../../common/context/request-context';
import { PrismaService } from '../../infra/prisma/prisma.service';

@Injectable()
export class RoleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(params: {
    name?: string;
    status?: number;
    page: number;
    pageSize: number;
  }): Promise<{ rows: SysRole[]; total: number }> {
    const where = {
      ...(params.name === undefined ? {} : { name: { contains: params.name } }),
      ...(params.status === undefined ? {} : { status: params.status }),
    };

    const [total, rows] = await Promise.all([
      this.prisma.client.sysRole.count({ where }),
      this.prisma.client.sysRole.findMany({
        where,
        orderBy: [{ id: 'asc' }],
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
    ]);

    return { rows, total };
  }

  async findById(id: bigint): Promise<SysRole | null> {
    return this.prisma.client.sysRole.findFirst({ where: { id } });
  }

  /** 角色编码全局唯一（uk_sys_role_code_active）；角色**名称**不唯一 */
  async existsByCode(code: string, excludeId?: bigint): Promise<boolean> {
    const found = await this.prisma.client.sysRole.findFirst({
      where: {
        code,
        ...(excludeId === undefined ? {} : { id: { not: excludeId } }),
      },
      select: { id: true },
    });

    return found !== null;
  }

  async create(data: {
    name: string;
    code: string;
    dataScope: string;
    status: number;
    remark?: string;
  }): Promise<SysRole> {
    // createdBy / updatedBy 是类型层面的必需字段，运行时被扩展剥掉重写
    // （同 dept.repository.ts:30-34）
    return this.prisma.client.sysRole.create({
      data: { ...data, createdBy: 0n, updatedBy: 0n },
    });
  }

  async update(
    id: bigint,
    data: {
      name: string;
      code?: string;
      dataScope?: string;
      status?: number;
      remark?: string | null;
    },
  ): Promise<SysRole> {
    return this.prisma.client.sysRole.update({ where: { id }, data });
  }

  /** 取一组角色的数据范围，供 DataScopeService 求最宽值 */
  async findDataScopesByRoleIds(roleIds: bigint[]): Promise<string[]> {
    if (roleIds.length === 0) {
      return [];
    }

    const rows = await this.prisma.client.sysRole.findMany({
      where: { id: { in: roleIds } },
      select: { dataScope: true },
    });

    return rows.map((row) => row.dataScope);
  }

  /**
   * spec 第 5 节删除策略：软删角色，**同一事务内**物理清掉两张连接行。
   * 软删不触发外键级联（外键只对物理 DELETE 生效），不清就是悬挂引用。
   * 软删是显式 `update`，事务语义由 `$transaction` 自己保证；
   * updatedAt/updatedBy 由扩展的 update 审计分支补上（DB-05/DB-06）。
   */
  async deleteWithRefs(id: bigint): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      await tx.sysUserRole.deleteMany({ where: { roleId: id } });
      await tx.sysRolePermission.deleteMany({ where: { roleId: id } });
      await tx.sysRole.update({
        where: { id },
        data: { deletedAt: new Date(), deletedBy: currentActorId() },
      });
    });
  }

  /** 该角色当前持有的用户（去重），供权限缓存清理（R10 ②⑥） */
  async findUserIdsByRoleId(roleId: bigint): Promise<bigint[]> {
    const rows = await this.prisma.client.sysUserRole.findMany({
      where: { roleId },
      select: { userId: true },
      distinct: ['userId'],
    });

    return rows.map((row) => row.userId);
  }

  /** 该用户当前持有的角色（去重），详情页与分配前的差集用 */
  async findRoleIdsByUserId(userId: bigint): Promise<bigint[]> {
    const rows = await this.prisma.client.sysUserRole.findMany({
      where: { userId },
      select: { roleId: true },
      distinct: ['roleId'],
    });

    return rows.map((row) => row.roleId);
  }

  /**
   * 用户↔角色的全量覆盖式分配落库（DB-10：连接表**物理**删除）。
   * 与 replacePermissions 同构——软删连接行会让「撤销后重新授予」撞 uk_sys_user_role。
   */
  async replaceUserRoles(
    userId: bigint,
    toAdd: bigint[],
    toRemove: bigint[],
  ): Promise<void> {
    if (toAdd.length === 0 && toRemove.length === 0) {
      return;
    }

    await this.prisma.client.$transaction(async (tx) => {
      if (toRemove.length > 0) {
        await tx.sysUserRole.deleteMany({
          where: { userId, roleId: { in: toRemove } },
        });
      }
      if (toAdd.length > 0) {
        await tx.sysUserRole.createMany({
          data: toAdd.map((roleId) => ({
            userId,
            roleId,
            // 占位，扩展会重写
            createdBy: 0n,
            updatedBy: 0n,
          })),
        });
      }
    });
  }

  async findPermissionIdsByRoleId(roleId: bigint): Promise<bigint[]> {
    const rows = await this.prisma.client.sysRolePermission.findMany({
      where: { roleId },
      select: { permissionId: true },
    });

    return rows.map((row) => row.permissionId);
  }

  /**
   * 全量覆盖式分配的落库动作（规范 DB-10：连接表**物理**删除）。
   * 物理删除是刻意的：软删会让「撤销后重新授予」撞 (role_id, permission_id)
   * 的唯一约束——spec 第 9 节最小回归集专门有一条用例钉它。
   */
  async replacePermissions(
    roleId: bigint,
    toAdd: bigint[],
    toRemove: bigint[],
  ): Promise<void> {
    if (toAdd.length === 0 && toRemove.length === 0) {
      return;
    }

    await this.prisma.client.$transaction(async (tx) => {
      if (toRemove.length > 0) {
        await tx.sysRolePermission.deleteMany({
          where: { roleId, permissionId: { in: toRemove } },
        });
      }
      if (toAdd.length > 0) {
        await tx.sysRolePermission.createMany({
          data: toAdd.map((permissionId) => ({
            roleId,
            permissionId,
            // 占位，扩展会重写（同 create 的注释）
            createdBy: 0n,
            updatedBy: 0n,
          })),
        });
      }
    });
  }
}
