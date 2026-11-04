import { Injectable } from '@nestjs/common';
import type { Prisma, SysDept, SysUser } from '@prisma/client';
import { hashSync } from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { BCRYPT_ROUNDS } from '../../common/constants/auth.constants';
import { currentActorId } from '../../common/context/request-context';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { SessionStore } from '../../infra/redis/session-store.service';

/** `SyncOrgUnit` → `SysDept` 的投影目标 */
export interface DeptProjection {
  name: string;
  parentId: bigint | null;
  sortOrder: number;
  status: number;
  remark: string | null;
}

/** `SyncPerson` → `SysUser` 的投影目标 */
export interface UserProjection {
  username: string;
  employeeNo: string;
  realName: string;
  mobile: string | null;
  deptId: bigint;
  /** 人员来自同步源 → sso；管理员手工建号 → local */
  authSource: 'local' | 'sso';
}

/** `updateUser` 只读这几个字段；用最小接口而不是 `SysUser`，provisioner 不必伪造整行 */
export interface UserProjectionSource {
  id: bigint;
  username: string;
  employeeNo: string;
  realName: string;
  mobile: string | null;
  deptId: bigint;
  deletedAt: Date | null;
}

/**
 * 投影写入器（规格 §2.4，R2 / R3）。**只管怎么落库**，判断「该不该落、落失败了
 * 怎么记」在 `SyncService`。
 *
 * 两条写入纪律：
 *
 * 1. **只用顶层 create / update**（Ruling 19）。`audit-args.util.ts` 的 `auditData`
 *    只改写顶层 `data` / `create` / `update` 三个载荷，嵌套载荷里的
 *    `createdBy` / `updatedBy` 会真的落那个 `0n` 占位值。
 * 2. **内容全同就不写**。幂等判据要求同一批跑两次表内容不变，真写了就对不齐。
 *    比对范围是下面两处 `equals` 点名的列，**不含** `password`（只在建号时写）、
 *    **不含** `isSuperAdmin` / `lastLoginAt`（管理员的领地）。
 *
 * 身份靠「上一次记下的 id」而不是名字（Ruling 22）：`sys_dept` 的自然键是
 * `(parent_id, name_active)`，名字不是稳定键，源系统一改名就会被当成换了一个部门。
 * 所以查找一律 `includingDeleted`——软删的行要能被**认出来并复活**，
 * 而不是另建一条同名的，把 `sys_user.dept_id` 晾在旧的那条上。
 */
@Injectable()
export class ProjectionWriter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionStore,
  ) {}

  // ---------- SysDept ----------

  /** 按 id 找（含软删的那条）。`null` = 上次没投影过，或者 id 指的行已经不在了 */
  async findDept(id: bigint): Promise<SysDept | null> {
    return this.prisma.includingDeleted.sysDept.findFirst({ where: { id } });
  }

  async createDept(desired: DeptProjection): Promise<SysDept> {
    return this.prisma.client.sysDept.create({
      data: {
        ...desired,
        // 类型占位：扩展会剥掉再按当前操作者重写。列 NOT NULL 且无默认值
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
  }

  /**
   * 更新（含复活软删的那条）。**内容全同就不写**——幂等的落点。
   * `createdBy` 不在比对范围：它是历史，不是投影的目标。
   */
  async updateDept(dept: SysDept, desired: DeptProjection): Promise<boolean> {
    // 源系统把它加回来了：复活同一条，不新建（Ruling 22 的全部意义就在这）
    const revive = dept.deletedAt !== null;
    const patch: Prisma.SysDeptUpdateInput = {
      ...(dept.name === desired.name ? {} : { name: desired.name }),
      ...(dept.parentId === desired.parentId
        ? {}
        : { parentId: desired.parentId }),
      ...(dept.sortOrder === desired.sortOrder
        ? {}
        : { sortOrder: desired.sortOrder }),
      ...(dept.status === desired.status ? {} : { status: desired.status }),
      ...(dept.remark === desired.remark ? {} : { remark: desired.remark }),
      ...(revive ? { deletedAt: null, deletedBy: null } : {}),
    };
    if (Object.keys(patch).length === 0) return false;
    await this.prisma.includingDeleted.sysDept.update({
      where: { id: dept.id },
      data: patch,
    });
    return true;
  }

  /**
   * 源系统删了这个单位 → `SysDept` 软删（计划原文：「源系统软删 → `SysDept` 软删」）。
   * 不用 `delete`：R24 那道守卫连同步作用域里也拒（离场没有第二条路）。
   * `deletedBy` 显式写，扩展只补 `updatedAt` / `updatedBy`。
   */
  async softDeleteDept(deptId: bigint): Promise<void> {
    await this.prisma.client.sysDept.update({
      where: { id: deptId },
      data: { deletedAt: new Date(), deletedBy: currentActorId() },
    });
  }

  // ---------- SysUser ----------

  /** 按 `username` 找（含软删）。`username` 就是 `SyncPerson.login`，见 `UserProjection` */
  async findUser(username: string): Promise<SysUser | null> {
    return this.prisma.includingDeleted.sysUser.findFirst({
      where: { username },
    });
  }

  /**
   * 根部门（`parentId IS NULL`）。SSO 登录自动建号要挂到它下面，
   * 定时同步也要复用它，避免出现第二个根。
   */
  async findRootDept(): Promise<SysDept | null> {
    return this.prisma.client.sysDept.findFirst({
      where: { parentId: null, deletedAt: null },
    });
  }

  /**
   * 只写密码哈希，**不 revoke 会话**。登录成功时同步 SSO 密码用它；
   * 本人改密 / 管理员重置仍走 `UserService` 那条会踢人的路径。
   */
  async updatePassword(id: bigint, passwordHash: string): Promise<void> {
    await this.prisma.client.sysUser.update({
      where: { id },
      data: { password: passwordHash },
    });
  }

  /**
   * 建号。**同步来的账号只走 SSO**：`password` 写一个没人知道的随机 bcrypt 哈希，
   * 本地密码登录必须走不通（`auth.service.ts` 会拿它去比对，永远比不上）。
   * 只在建号这一次写，之后再不动它——管理员重置的密码不该被同步冲掉。
   */
  async createUser(desired: UserProjection): Promise<SysUser> {
    return this.prisma.client.sysUser.create({
      data: {
        ...desired,
        password: hashSync(
          randomBytes(32).toString('base64url'),
          BCRYPT_ROUNDS,
        ),
        status: 1,
        isSuperAdmin: false,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
  }

  /**
   * 更新人员信息。**内容全同就不写**。不碰 `password` / `status` /
   * `isSuperAdmin` / `lastLoginAt`——登录态是本地的（`SysUser` 只保留登录态与
   * 角色绑定，人员信息才是投影的），管理员说了算；唯一例外是源系统删人时
   * {@link disableUser} 把 `status` 收成 0，那是安全收缩，不反向。
   */
  async updateUser(
    user: UserProjectionSource,
    desired: UserProjection,
  ): Promise<boolean> {
    const revive = user.deletedAt !== null;
    const patch: Prisma.SysUserUpdateInput = {
      ...(user.username === desired.username
        ? {}
        : { username: desired.username }),
      ...(user.employeeNo === desired.employeeNo
        ? {}
        : { employeeNo: desired.employeeNo }),
      ...(user.realName === desired.realName
        ? {}
        : { realName: desired.realName }),
      ...(user.mobile === desired.mobile ? {} : { mobile: desired.mobile }),
      ...(user.deptId === desired.deptId ? {} : { deptId: desired.deptId }),
      ...(revive ? { deletedAt: null, deletedBy: null } : {}),
    };
    if (Object.keys(patch).length === 0) return false;
    await this.prisma.includingDeleted.sysUser.update({
      where: { id: user.id },
      data: patch,
    });
    return true;
  }

  /**
   * 源系统删人 → **账号停用但不消失**（计划的投影用例原文）。
   * 落的是 `status = 0`，不是软删：历史业务数据要能继续关联到人，
   * 而 `sys_user` 软删会让 `sys_user_dept` 的联查与数据权限一起落空。
   *
   * **只往 0 收，不往 1 放**：人回到源系统里，账号不会自动复活——
   * 复活是管理员的事（`PUT /:id/status`）。宁可「回来了还登不上、找管理员」，
   * 也不要「同步把管理员手动停用的号悄悄打开」。
   */
  async disableUser(userId: bigint): Promise<void> {
    await this.prisma.client.sysUser.update({
      where: { id: userId },
      data: { status: 0 },
    });
    // 停用必须同时踢下线：只改 status 的话，已签发的 access 令牌还能用满 2 小时。
    await this.sessions.revokeSessions(userId);
  }

  /** 这个账号现在绑了几个角色。**0 个才补默认角色**——有角色就不再碰（Ruling 24） */
  async countUserRoles(userId: bigint): Promise<number> {
    return this.prisma.client.sysUserRole.count({ where: { userId } });
  }

  /**
   * 绑默认角色。`SysUserRole` 是连接表：**物理删除**（DB-10），没有软删两列，
   * 撤销授权后再授予不会撞唯一键。
   */
  async bindRole(userId: bigint, roleId: bigint): Promise<void> {
    await this.prisma.client.sysUserRole.create({
      data: {
        userId,
        roleId,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
  }

  /** 按 code 找角色 id。角色是**管理员配的**，同步任务不自建——找不到就记失败 */
  async findRoleIdByCode(code: string): Promise<bigint | null> {
    const role = await this.prisma.client.sysRole.findFirst({
      where: { code },
      select: { id: true },
    });
    return role?.id ?? null;
  }
}
