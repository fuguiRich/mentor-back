import { Injectable } from '@nestjs/common';
import type { Prisma, SysUser } from '@prisma/client';
import { currentActorId } from '../../common/context/request-context';
import type { DataScopeFilter } from '../../common/constants/data-scope';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** 列表与详情都要显示部门名（spec 第 4 节例外 ①：关系包含用于展示） */
export type UserWithDeptName = SysUser & { dept: { name: string } };

const USER_WITH_DEPT = { dept: { select: { name: true } } } as const;

/**
 * sys_user 的「自己那一份」就是**自己那一行**——
 * 业务表（将来 mentor 档案那类）的 self 译成 `created_by = userId`，不是同一个键。
 * 这就是 DataScopeFilter 带 userId 而不直接带 where 的原因。
 */
function scopeClauses(scope?: DataScopeFilter): Prisma.SysUserWhereInput[] {
  if (scope === undefined || scope.kind === 'all') {
    return [];
  }
  if (scope.kind === 'self') {
    return [{ id: scope.userId }];
  }
  // 空数组 → `in: []` → 一行都不返回。这是有意的 fail-closed，不是漏判
  return [{ deptId: { in: scope.deptIds } }];
}

export interface UserListParams {
  username?: string;
  realName?: string;
  employeeNo?: string;
  deptId?: bigint;
  status?: number;
  /** 由 roleId 筛选换算而来；undefined = 不按角色过滤，[] = 谁都不是 */
  userIds?: bigint[];
  /** 数据范围。undefined = 不加行级约束（仅供认证链路等非列表场景） */
  scope?: DataScopeFilter;
}

/**
 * 用户列表的 where。**抽成纯函数是为了能钉住条件的形状**：
 * deptId 与 scope 的部门集合、userIds 与 scope 的 selfId 都会落到同一个
 * where 键上，用对象展开合并时后写的那个会静默吃掉先写的那个，
 * 而「查不出任何人」与「这人权限就是这么窄」在结果上一模一样。
 */
export function buildUserListWhere(
  params: UserListParams,
): Prisma.SysUserWhereInput {
  const clauses: Prisma.SysUserWhereInput[] = [
    ...(params.username === undefined
      ? []
      : [{ username: { contains: params.username } }]),
    ...(params.realName === undefined
      ? []
      : [{ realName: { contains: params.realName } }]),
    ...(params.employeeNo === undefined
      ? []
      : [{ employeeNo: { contains: params.employeeNo } }]),
    ...(params.deptId === undefined ? [] : [{ deptId: params.deptId }]),
    ...(params.status === undefined ? [] : [{ status: params.status }]),
    ...(params.userIds === undefined ? [] : [{ id: { in: params.userIds } }]),
    ...scopeClauses(params.scope),
  ];
  return clauses.length === 0 ? {} : { AND: clauses };
}

/**
 * 用户模块的数据访问。本文件由 Task 2 建骨架（认证链路只需「按名/按 id 读」+ 登录簿记），
 * Task 5 在其上补全 CRUD。
 *
 * 为什么不放 auth 模块：spec 第 4 节的依赖方向是 auth → user，
 * 而 `sys_user` 归 user 模块所有。auth 若自己写 `prisma.sysUser`，就跨模块写别人的表
 * （见 dept.repository.ts 里 countUsers 的注释——那条窄口子只允许**只读校验**）。
 */
@Injectable()
export class UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByUsername(username: string): Promise<SysUser | null> {
    return this.prisma.client.sysUser.findFirst({ where: { username } });
  }

  /** SSO 回调按工号映射本地账号（spec 第 7 节：拿工号 → 映射本地用户，不自动建号） */
  async findByEmployeeNo(employeeNo: string): Promise<SysUser | null> {
    return this.prisma.client.sysUser.findFirst({ where: { employeeNo } });
  }

  /** 人员类型（SyncPerson.personType），用于 /auth/profile 提前判断内校/外校 */
  async findPersonTypeByUsername(username: string): Promise<string | null> {
    const person = await this.prisma.client.syncPerson.findFirst({
      where: { login: username },
      select: { personType: true },
    });
    return person?.personType ?? null;
  }

  /**
   * 学生档案展示字段（§2.1）：专业 / 行政班级 / 学院。
   * 与 personType 同源，都是 `SysUser.username ↔ SyncPerson.login` 的自然键投影。
   * 查不到人员行时返回 null——调用方按「未知」处理，不报错。
   */
  async findPersonProfileByUsername(username: string): Promise<{
    personType: string;
    major: string | null;
    className: string | null;
    orgUnitName: string;
  } | null> {
    const person = await this.prisma.client.syncPerson.findFirst({
      where: { login: username },
      select: {
        personType: true,
        major: true,
        className: true,
        orgUnit: { select: { name: true } },
      },
    });
    if (person === null) {
      return null;
    }
    return {
      personType: person.personType,
      major: person.major,
      className: person.className,
      orgUnitName: person.orgUnit.name,
    };
  }

  async findById(id: bigint): Promise<SysUser | null> {
    return this.prisma.client.sysUser.findFirst({ where: { id } });
  }

  /**
   * 记一次登录时间。
   *
   * 要说清的一件事：审计扩展会给**任何** update 补 updatedAt / updatedBy
   * （prisma.extension.ts 的 'update' 分支），所以每次登录都会把这两个字段
   * 顶到「此刻 / 0」。这是接受的，不是漏写——last_login_at 本身就是对本行的一次写入，
   * updated_* 随之刷新并非假话；真要让登录不惊动审计字段，得给扩展开一个
   * 「跳过审计」的入口，而那是一个能绕过审计的后门，代价比这里的问题大得多。
   * 若将来产品要把「最后修改人」与「最后登录」分开显示，改这里之前先读这段。
   */
  async recordLogin(userId: bigint): Promise<void> {
    await this.prisma.client.sysUser.update({
      where: { id: userId },
      data: { lastLoginAt: new Date() },
    });
  }

  async findMany(
    params: UserListParams & { page: number; pageSize: number },
  ): Promise<{ rows: UserWithDeptName[]; total: number }> {
    const where = buildUserListWhere(params);

    const [total, rows] = await Promise.all([
      this.prisma.client.sysUser.count({ where }),
      this.prisma.client.sysUser.findMany({
        where,
        orderBy: [{ id: 'asc' }],
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: USER_WITH_DEPT,
      }),
    ]);

    return { rows, total };
  }

  /** 详情用。**不要**改 Task 2 的 `findById`——auth 的登录链路要用它 */
  async findByIdWithDept(id: bigint): Promise<UserWithDeptName | null> {
    return this.prisma.client.sysUser.findFirst({
      where: { id },
      include: USER_WITH_DEPT,
    });
  }

  /** 彻底删除要能看到软删过的行——「先软删再清理」必须走得通 */
  async findByIdIncludingDeleted(id: bigint): Promise<SysUser | null> {
    return this.prisma.includingDeleted.sysUser.findFirst({ where: { id } });
  }

  /**
   * 三个业务唯一键的预检（DB-11 的 username_active / employee_no_active /
   * mobile_active 是并发兜底，预检只是给好文案的快路径，见本计划「开工前的
   * 一条更正」）。excludeId 用于 update 时排除自己。
   */
  async existsByUsername(
    username: string,
    excludeId?: bigint,
  ): Promise<boolean> {
    const found = await this.prisma.client.sysUser.findFirst({
      where: {
        username,
        ...(excludeId === undefined ? {} : { id: { not: excludeId } }),
      },
      select: { id: true },
    });
    return found !== null;
  }

  async existsByEmployeeNo(
    employeeNo: string,
    excludeId?: bigint,
  ): Promise<boolean> {
    const found = await this.prisma.client.sysUser.findFirst({
      where: {
        employeeNo,
        ...(excludeId === undefined ? {} : { id: { not: excludeId } }),
      },
      select: { id: true },
    });
    return found !== null;
  }

  async existsByMobile(mobile: string, excludeId?: bigint): Promise<boolean> {
    const found = await this.prisma.client.sysUser.findFirst({
      where: {
        mobile,
        ...(excludeId === undefined ? {} : { id: { not: excludeId } }),
      },
      select: { id: true },
    });
    return found !== null;
  }

  /**
   * 建号并绑角色——**两笔写一次事务**（Ruling 34）。
   *
   * 必须原子：绑定失败而账号已经落库 = 留下一个「能登录但一个角色都没有」的号，
   * 那正是 `createAccount` 拒绝 `roleIds: []` 时说的、比不建更坏的状态。
   * 常规失败已被前面的 `assertExists` 预检挡掉；真能走到这一步再挂，
   * 只剩「DB 不听话」一种。补偿式回删也要写 DB，挡不住它——**只有事务挡得住**。
   *
   * 本方法写 `sys_user_role`，与下面的 `purge` 是同一个先例：多表写要原子时，
   * 用户仓储认这张连接表。角色的**读**与通用的全量覆盖（`replaceUserRoles`）仍归
   * role 模块，这里不碰。
   */
  async createWithRoles(
    data: {
      username: string;
      password: string;
      realName: string;
      employeeNo: string;
      mobile: string | null;
      deptId: bigint;
      status: number;
      isSuperAdmin: boolean;
    },
    roleIds: bigint[],
  ): Promise<UserWithDeptName> {
    return this.prisma.client.$transaction(async (tx) => {
      const created = await tx.sysUser.create({
        data: { ...data, createdBy: 0n, updatedBy: 0n },
        include: USER_WITH_DEPT,
      });
      if (roleIds.length > 0) {
        await tx.sysUserRole.createMany({
          data: roleIds.map((roleId) => ({
            userId: created.id,
            roleId,
            // 占位，运行时被审计扩展剥掉重写（DB-05）
            createdBy: 0n,
            updatedBy: 0n,
          })),
        });
      }
      return created;
    });
  }

  async update(
    id: bigint,
    data: {
      username: string;
      realName?: string;
      employeeNo?: string;
      mobile?: string | null;
      deptId?: bigint;
      status?: number;
      isSuperAdmin?: boolean;
    },
  ): Promise<UserWithDeptName> {
    return this.prisma.client.sysUser.update({
      where: { id },
      data,
      include: USER_WITH_DEPT,
    });
  }

  async updatePassword(
    id: bigint,
    passwordHash: string,
  ): Promise<UserWithDeptName> {
    return this.prisma.client.sysUser.update({
      where: { id },
      data: { password: passwordHash },
      include: USER_WITH_DEPT,
    });
  }

  /** 软删除：显式写 deleted_at / deleted_by（DB-09）；updatedAt/updatedBy 由扩展的 update 审计分支补 */
  async softDelete(id: bigint): Promise<void> {
    await this.prisma.client.sysUser.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: currentActorId() },
    });
  }

  /**
   * 彻底删除（R6 的第二道门在 Service）。**走 includingDeleted**——软删过的
   * 账号也要能清理。sys_user_role 的行在同一事务里物理清掉，不依赖外键级联
   * （外键有 onDelete: Cascade，但"显式清"与"靠级联"是两种形状，取前者，
   * 与 role.repository 的 deleteWithRefs 一致）。
   */
  async purge(id: bigint): Promise<void> {
    await this.prisma.includingDeleted.$transaction(async (tx) => {
      await tx.sysUserRole.deleteMany({ where: { userId: id } });
      await tx.sysUser.delete({ where: { id } });
    });
  }
}
