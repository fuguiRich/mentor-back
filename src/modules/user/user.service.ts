import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type SysUser } from '@prisma/client';
import { hashSync } from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { BCRYPT_ROUNDS } from '../../common/constants/auth.constants';
import type { DataScopeFilter } from '../../common/constants/data-scope';
import { ErrorCode } from '../../common/constants/error-code';
import {
  currentDataScopeCeiling,
  type RequestUser,
} from '../../common/context/request-context';
import { BusinessException } from '../../common/errors/business.exception';
import { SessionStore } from '../../infra/redis/session-store.service';
import { DataScopeService } from '../data-scope/data-scope.service';
import { DeptService } from '../dept/dept.service';
import { RoleService } from '../role/role.service';
import { UserRepository } from './user.repository';
import { toUserDetailResponse, toUserResponse } from './user.mapper';
import type { UserWithDeptName } from './user.repository';
import type { QueryUserDto } from './dto/query-user.dto';
import type { CreateUserAccountDto } from './dto/create-user-account.dto';
import type { UpdateUserStatusDto } from './dto/update-user-status.dto';
import type { ResetUserPasswordDto } from './dto/reset-user-password.dto';
import type { AssignUserRolesDto } from './dto/assign-user-roles.dto';
import type { UserPageResponseDto } from './dto/user-page-response.dto';
import type { UserResponseDto } from './dto/user-response.dto';
import type { UserDetailResponseDto } from './dto/user-detail-response.dto';

/**
 * 用户模块的对外服务。
 *
 * Task 2 是认证链路要用的那几个签名（findByUsername / findById / recordLogin /
 * findByEmployeeNo / changeOwnPassword）——auth 模块已按它们在跑，改签名就是改
 * 一个正在运行的契约，不动。
 *
 * Task 5 加的通用 CRUD 在 Task 6b **收口**了：人的姓名 / 工号 / 部门 / 手机归
 * 源系统（6a 的同步投影），这里只剩登录态（status / password）与角色绑定，
 * 外加一条受限建号入口 `createAccount`（Ruling 28）。
 */
@Injectable()
export class UserService {
  constructor(
    private readonly repository: UserRepository,
    private readonly roles: RoleService,
    private readonly depts: DeptService,
    private readonly sessions: SessionStore,
    private readonly dataScope: DataScopeService,
  ) {}

  async findByUsername(username: string): Promise<SysUser | null> {
    return this.repository.findByUsername(username);
  }

  async findById(id: bigint): Promise<SysUser | null> {
    return this.repository.findById(id);
  }

  /** 角色变更后清权限缓存：下一次请求按新角色重新算权限 */
  async clearPermissionCache(userId: bigint): Promise<void> {
    await this.sessions.clearPermissions([userId]);
  }

  /** 审核通过时解析「给谁绑哪个角色」；用户或角色不存在返回 null */
  async resolveRoleGrant(
    username: string,
    roleCode: string,
  ): Promise<{ userId: bigint; roleId: bigint } | null> {
    const user = await this.repository.findByUsername(username);
    if (user === null) return null;
    const roleId = await this.roles.findIdByCode(roleCode);
    if (roleId === null) return null;
    return { userId: user.id, roleId };
  }

  /** 人员类型：用于 /auth/profile 返回 personType / mentorType */
  async findPersonTypeByUsername(username: string): Promise<string | null> {
    return this.repository.findPersonTypeByUsername(username);
  }

  async recordLogin(userId: bigint): Promise<void> {
    await this.repository.recordLogin(userId);
  }

  /** SSO 回调按工号找人。找不到不报错——那是一个要单独回应的情形（20107） */
  async findByEmployeeNo(employeeNo: string): Promise<SysUser | null> {
    return this.repository.findByEmployeeNo(employeeNo);
  }

  /**
   * 本人改密。旧密码的校验在 AuthService（凭证校验归认证模块，与 login 同一处 bcrypt）；
   * R21 不适用——这条路径只能改**自己**的密码，没有"接管别人"的通道。
   * 与 resetPassword 的唯一差别就是「谁校验了旧密码」，落库与作废令牌完全同构。
   */
  async changeOwnPassword(
    id: bigint,
    passwordHash: string,
  ): Promise<UserResponseDto> {
    // R14：先作废再落库——落库失败 → 被踢下线但改动没生效，重新登录就恢复。可恢复。
    await this.sessions.revokeSessions(id);
    const updated = await this.repository.updatePassword(id, passwordHash);
    return toUserResponse(updated);
  }

  /**
   * SSO 登录成功后的本地回写：人员信息归源系统，密码只作为故障回退。
   *
   * **不 revoke 会话**：这不是「改密码」的语义，而是把源系统的最新密码镜像到本地。
   * 调用方（AuthService）已经算好 `passwordHash = null` 表示「本次密码与本地一致」，
   * 这里只在非 null 时写。
   */
  async syncSsoProfile(
    id: bigint,
    input: {
      realName: string;
      deptId: bigint | null;
      passwordHash: string | null;
    },
  ): Promise<void> {
    const current = await this.repository.findById(id);
    if (current === null || current.status !== 1) {
      throw new BusinessException(
        ErrorCode.AUTH_ACCOUNT_DISABLED,
        '账号已停用，请联系管理员',
        HttpStatus.UNAUTHORIZED,
      );
    }

    await this.repository.update(id, {
      username: current.username,
      realName: input.realName,
      ...(input.deptId === null ? {} : { deptId: input.deptId }),
    });

    if (input.passwordHash !== null) {
      await this.repository.updatePassword(id, input.passwordHash);
    }
  }

  async assertExists(id: bigint): Promise<void> {
    await this.mustFind(id);
  }

  async findPage(
    query: QueryUserDto,
    caller: RequestUser,
  ): Promise<UserPageResponseDto> {
    const page = query.page;
    const pageSize = query.pageSize;
    // 一次换算，越权判定与 where 共用同一个值（传字符串进来会走两次 BigInt）
    const deptId =
      query.deptId === undefined ? undefined : BigInt(query.deptId);

    // 顺序：先算 filter → 再判越权（403）→ 再查列表。越权时一个查询都不发。
    const scope = await this.resolveScope(caller);
    if (deptId !== undefined) {
      // 越权必须 403，不是「范围外的 deptId 与范围求交 → 空列表」——
      // 否则前端分不清『没数据』和『没权限』。
      this.dataScope.assertDeptVisible(scope, deptId);
    }

    // roleId → 该角色的成员 ID 列表（role 模块的表，走 RoleService，R13：
    // 不存在的角色 ID 在这里是「没人有这个角色」，交出空列表而不是 404）
    const userIds =
      query.roleId === undefined
        ? undefined
        : await this.roles.findUserIdsByRoleId(BigInt(query.roleId));

    const { rows, total } = await this.repository.findMany({
      username: query.username,
      realName: query.realName,
      employeeNo: query.employeeNo,
      deptId,
      status: query.status,
      userIds,
      scope,
      page,
      pageSize,
    });

    return { list: rows.map(toUserResponse), total, page, pageSize };
  }

  /**
   * 行级数据范围。只在**列表**接口生效——详情、改、删走各自的权限点，
   * 那是 PermissionGuard 的事（规范：数据范围管「看得见哪些行」，
   * 权限点管「能不能做这个动作」，两者不是同一件事，混在一个判断里
   * 就会出现「看得见就改得动」这种没人要求过的耦合）。
   *
   * 部门从库里现取：令牌载荷里没有部门，而部门会随调岗变化——
   * 写进 JWT 就得等令牌过期才生效，调岗当天被调走的人还能看原部门一整个令牌周期。
   *
   * 上限取 `currentDataScopeCeiling()`（`@DataScope` 声明、拦截器写进上下文）：
   * 角色范围与接口上限求窄，`'all'` 时行为与不设上限逐字相同。
   */
  private async resolveScope(caller: RequestUser): Promise<DataScopeFilter> {
    const self = await this.repository.findById(caller.userId);
    return this.dataScope.resolve(
      {
        userId: caller.userId,
        isSuperAdmin: caller.isSuperAdmin,
        deptId: self?.deptId ?? null,
      },
      currentDataScopeCeiling(),
    );
  }

  async findOne(id: bigint): Promise<UserDetailResponseDto> {
    const entity = await this.mustFind(id);
    const roleIds = await this.roles.findRoleIdsByUserId(id);
    return toUserDetailResponse(entity, roleIds);
  }

  /**
   * 受限建号（Ruling 28）：只做「建号 + 绑角色」，不做人员信息录入。
   *
   * **建号即定型**：`username` / `realName` / `employeeNo` / `deptId` 这 **4 个人员信息
   * 字段**落库后不再有任何接口能改（同步投影覆盖过来的行另说，那是源系统在改）。
   * 这是「人员信息归源系统」的必然代价，**不是漏实现**——管理员把姓名写错
   * 只能重建账号，换来的是「谁的姓名归谁管」这条线不留歧义。
   *
   * 入参 6 个字段里，定型的只有上面 4 个。另外两个**本任务特意留了写口**，不在定型范围：
   * `password` 走 `PUT /users/:id/password`，`roleIds` 走 `PUT /users/:id/roles`
   * ——它们是登录态与角色绑定，归管理员，不归源系统。
   *
   * password（Ruling 33）：给就用它，不给就 `randomBytes(9).toString('base64url')`
   * 随机生成；两者都以 bcrypt 落库，**明文不回、不记日志**。没设口令的账号走
   * SSO（employeeNo 已落，`GET /auth/sso/callback?ticket=<employeeNo>` 即可登录）；
   * 要给对方口令，超管用既有 `PUT /users/:id/password` 设一个他知道的。
   */
  async createAccount(
    dto: CreateUserAccountDto,
    actorId: bigint,
  ): Promise<UserDetailResponseDto> {
    // actorId 是计划 §3.1 的签名契约（「谁建的号」）。审计字段由 Prisma 扩展从
    // 请求上下文注入（DB-05：created_by = currentActorId()），这里不再手写赋值——
    // 传进去也会被扩展剥掉重写。显式引用一次，免得被后来人当死参数删掉。
    void actorId;

    await this.assertIdentifiersAvailable({
      username: dto.username,
      employeeNo: dto.employeeNo,
    });

    // 与 PUT /users/:id/roles 不同：那边 [] 是「清空角色」，这边去重后 [] 是
    // 「建号没绑角色」——比不建更坏（能登录但什么都看不见），直接拒（10001）。
    const targetIds = [...new Set(dto.roleIds.map((raw) => BigInt(raw)))];
    if (targetIds.length === 0) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        'roleIds 至少要有一个角色',
        HttpStatus.BAD_REQUEST,
      );
    }
    for (const roleId of targetIds) {
      await this.roles.assertExists(roleId); // → 22101（R13 的括号）
    }

    // deptId 不存在 → PARAM_INVALID = 10001（这是建号入参非法，不是部门详情语义，
    // 所以不走 assertExists 的 24101）。只读校验，不是第二条写 SysDept 的路。
    if (!(await this.depts.exists(BigInt(dto.deptId)))) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        '部门不存在',
        HttpStatus.BAD_REQUEST,
      );
    }

    // password 不留、不回、不记日志（Ruling 33）；两分支同走 bcrypt 落库
    const passwordPlain = dto.password ?? randomBytes(9).toString('base64url');

    // 建号与绑角色是**一次事务**（Ruling 34）：绑定失败而账号已落库，
    // 留下的正是上面拒绝 `roleIds: []` 时说的「能登录但什么都没有」的号
    let created: UserWithDeptName;
    try {
      created = await this.repository.createWithRoles(
        {
          username: dto.username,
          password: hashSync(passwordPlain, BCRYPT_ROUNDS),
          realName: dto.realName,
          employeeNo: dto.employeeNo,
          mobile: null,
          deptId: BigInt(dto.deptId),
          status: 1,
          isSuperAdmin: false,
        },
        targetIds,
      );
    } catch (error) {
      await this.rethrowIfIdentifiersTaken(error, {
        username: dto.username,
        employeeNo: dto.employeeNo,
      });
      throw error;
    }

    return toUserDetailResponse(created, targetIds);
  }

  async updateStatus(
    id: bigint,
    dto: UpdateUserStatusDto,
  ): Promise<UserResponseDto> {
    const current = await this.mustFind(id);
    await this.applyStatusChange(id, dto.status, current);

    const updated = await this.repository.update(id, {
      username: current.username,
      status: dto.status,
    });

    return toUserResponse(updated);
  }

  /** 管理员重置密码（不校验旧密码）。R21：超管账号只有超管能重置 */
  async resetPassword(
    id: bigint,
    dto: ResetUserPasswordDto,
    caller: RequestUser,
  ): Promise<UserResponseDto> {
    const current = await this.mustFind(id);
    if (current.isSuperAdmin && !caller.isSuperAdmin) {
      throw new BusinessException(
        ErrorCode.FORBIDDEN,
        '无权限',
        HttpStatus.FORBIDDEN,
      );
    }

    // R14：先作废再落库，无条件
    await this.sessions.revokeSessions(id);
    const updated = await this.repository.updatePassword(
      id,
      hashSync(dto.password, BCRYPT_ROUNDS),
    );
    return toUserResponse(updated);
  }

  /**
   * 全量覆盖式分配角色（spec 第 8 节「分配类接口一律全量覆盖」），
   * 与 RoleService.assignPermissions 同构：差集在服务端算，重复 ID 去重。
   */
  async assignRoles(
    id: bigint,
    dto: AssignUserRolesDto,
  ): Promise<UserDetailResponseDto> {
    await this.mustFind(id);

    const targetIds = [...new Set(dto.roleIds.map((raw) => BigInt(raw)))];
    for (const roleId of targetIds) {
      await this.roles.assertExists(roleId); // → 22101（R13 的括号）
    }

    const currentIds = await this.roles.findRoleIdsByUserId(id);
    const currentSet = new Set(currentIds.map((value) => value.toString()));
    const targetSet = new Set(targetIds.map((value) => value.toString()));

    const toAdd = targetIds.filter(
      (value) => !currentSet.has(value.toString()),
    );
    const toRemove = currentIds.filter(
      (value) => !targetSet.has(value.toString()),
    );

    await this.roles.replaceUserRoles(id, toAdd, toRemove);

    // R10 ③：改的是这个用户的角色，清的就是这个用户的权限缓存
    await this.sessions.clearPermissions([id]);

    return toUserDetailResponse(await this.mustFind(id), targetIds);
  }

  private async mustFind(id: bigint): Promise<UserWithDeptName> {
    const entity = await this.repository.findByIdWithDept(id);
    if (entity === null) {
      this.notFound();
    }
    return entity;
  }

  /** 「用户不存在」只此一处定义 */
  private notFound(): never {
    throw new BusinessException(
      ErrorCode.USER_NOT_FOUND,
      '用户不存在',
      HttpStatus.NOT_FOUND,
    );
  }

  private superAdminProtected(): BusinessException {
    return new BusinessException(
      ErrorCode.USER_SUPER_ADMIN_PROTECTED,
      '超级管理员受保护，不能执行该操作',
      HttpStatus.CONFLICT,
    );
  }

  /**
   * 状态变更的守卫 + 令牌作废（R7④ / R14），`updateStatus` **专用**
   * （6b 收口后 update 已删，这里不再有第二个调用方）。
   *
   * 顺序：先判 21105（超管保护优先，抛时无副作用），再做 revoke。
   * next 与当前值相同 → 无副作用。
   * 0→1 不 revoke（启用不是「让人不能再访问」）。
   */
  private async applyStatusChange(
    targetId: bigint,
    next: number,
    current: UserWithDeptName,
  ): Promise<void> {
    if (next === current.status) {
      return;
    }

    // R7④：超管账号不可停用。next === 1 不触发（超管本来就是启用的）
    if (current.isSuperAdmin && next === 0) {
      throw this.superAdminProtected();
    }

    // R14：停用 = 让人不能再访问 → 必须作废令牌
    if (next === 0) {
      await this.sessions.revokeSessions(targetId);
    }
  }

  private async assertIdentifiersAvailable(
    input: { username: string; employeeNo: string },
    excludeId?: bigint,
  ): Promise<void> {
    if (await this.repository.existsByUsername(input.username, excludeId)) {
      throw new BusinessException(
        ErrorCode.USER_NAME_TAKEN,
        '用户名已存在',
        HttpStatus.CONFLICT,
      );
    }
    if (await this.repository.existsByEmployeeNo(input.employeeNo, excludeId)) {
      throw new BusinessException(
        ErrorCode.USER_EMPLOYEE_NO_TAKEN,
        '工号已存在',
        HttpStatus.CONFLICT,
      );
    }
  }

  /**
   * 并发撞库键的兜底（DB-11 的 *_active 唯一键）。
   *
   * sys_user 的业务唯一键有 username_active / employee_no_active / mobile_active
   * 三个，P2002 说不清是哪个——Prisma 的 `meta.target` 在 MySQL 上的形状
   * （索引名还是列名）不可靠，不猜它。改成拿入参反查一遍，是哪个被占就回哪个码；
   * 都没查到（对方刚删掉）就回通用 10006。代价：竞争分支上多 1~2 次只读查询。
   * 这条路径本来就极少走到。（6b 收口后手机号不再有写入口，入参只剩两个。）
   */
  private async rethrowIfIdentifiersTaken(
    error: unknown,
    input: { username: string; employeeNo: string },
    excludeId?: bigint,
  ): Promise<void> {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    ) {
      return;
    }

    await this.assertIdentifiersAvailable(input, excludeId);
    throw new BusinessException(
      ErrorCode.CONFLICT,
      '数据冲突，请刷新后重试',
      HttpStatus.CONFLICT,
    );
  }
}
