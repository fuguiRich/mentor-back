import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorCode } from '../../common/constants/error-code';
import { BusinessException } from '../../common/errors/business.exception';
import { SessionStore } from '../../infra/redis/session-store.service';
import { PermissionService } from '../permission/permission.service';
import { RoleRepository } from './role.repository';
import { toRoleDetailResponse, toRoleResponse } from './role.mapper';
import type { SysRole } from '@prisma/client';
import type { QueryRoleDto } from './dto/query-role.dto';
import type { CreateRoleDto } from './dto/create-role.dto';
import type { UpdateRoleDto } from './dto/update-role.dto';
import type { UpdateRoleStatusDto } from './dto/update-role-status.dto';
import type { AssignRolePermissionsDto } from './dto/assign-role-permissions.dto';
import type { RolePageResponseDto } from './dto/role-page-response.dto';
import type { RoleResponseDto } from './dto/role-response.dto';
import type { RoleDetailResponseDto } from './dto/role-detail-response.dto';

@Injectable()
export class RoleService {
  constructor(
    private readonly repository: RoleRepository,
    private readonly permissions: PermissionService,
    private readonly sessions: SessionStore,
  ) {}

  /** 供其他模块校验角色存在；Task 5 的 `PUT /users/:id/roles` 会用到 */
  async assertExists(id: bigint): Promise<void> {
    const exists = await this.repository.findById(id);
    if (exists === null) {
      this.notFound();
    }
  }

  /** 供 user 模块读「这个用户有哪些角色」（spec 第 4 节 user → role） */
  async findRoleIdsByUserId(userId: bigint): Promise<bigint[]> {
    return this.repository.findRoleIdsByUserId(userId);
  }

  /**
   * 供 user 模块全量覆盖式分配角色。只负责落库差集；
   * 受影响者的权限缓存由**调用方**清（裁决 R10 ③：清的是那一个用户）。
   */
  async replaceUserRoles(
    userId: bigint,
    toAdd: bigint[],
    toRemove: bigint[],
  ): Promise<void> {
    await this.repository.replaceUserRoles(userId, toAdd, toRemove);
  }

  /**
   * 供 user 模块把「按角色筛选」换算成用户 ID 列表（GET /users?roleId=）。
   * `sys_user_role` 归本模块，user 不直接查这张表（spec 第 4 节的箭头）。
   */
  async findUserIdsByRoleId(roleId: bigint): Promise<bigint[]> {
    return this.repository.findUserIdsByRoleId(roleId);
  }

  async findPage(query: QueryRoleDto): Promise<RolePageResponseDto> {
    const { rows, total } = await this.repository.findMany({
      name: query.name,
      status: query.status,
      page: query.page,
      pageSize: query.pageSize,
    });

    return {
      list: rows.map(toRoleResponse),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async findOne(id: bigint): Promise<RoleDetailResponseDto> {
    const entity = await this.repository.findById(id);
    if (entity === null) {
      this.notFound();
    }

    const permissionIds = await this.repository.findPermissionIdsByRoleId(id);
    return toRoleDetailResponse(entity, permissionIds);
  }

  async create(dto: CreateRoleDto): Promise<RoleResponseDto> {
    await this.assertCodeAvailable(dto.code);

    try {
      const created = await this.repository.create({
        name: dto.name,
        code: dto.code,
        // 默认 self：新建角色不声明数据范围时收得最紧，不默认放行（D-SCOPE-01）
        dataScope: dto.dataScope ?? 'self',
        status: dto.status ?? 1,
        ...(dto.remark === undefined ? {} : { remark: dto.remark }),
      });
      return toRoleResponse(created);
    } catch (error) {
      this.rethrowIfCodeTaken(error);
      throw error;
    }
  }

  async update(id: bigint, dto: UpdateRoleDto): Promise<RoleResponseDto> {
    const current = await this.repository.findById(id);
    if (current === null) {
      this.notFound();
    }

    // PartialType 给每个字段补的 @IsOptional() 挡不住 null——它只跳过 null / undefined，
    // 所以 `code: null` / `status: null` 会一路到达这里；而这两列在库里是 NOT NULL，
    // 原样送进 Prisma 会在写库时炸，把「字段值非法」变成 500。
    //
    // 为什么不在 DTO 层挡：子类里重新声明同名属性只会**叠加**装饰器——class-validator
    // 沿原型链收集元数据，父类那条 @IsOptional() 仍在，@ValidateIf 也加不过它。唯一的
    // DTO 层修法是把这两个字段从 PartialType 里摘出来、手写一遍校验——两套校验器，
    // 正是评审模板认定的缺陷。所以明确挡在 Service：干净一致地回 400，不外溢。
    const nullFields: string[] = [];
    if (dto.code === null) {
      nullFields.push('code');
    }
    if (dto.status === null) {
      nullFields.push('status');
    }
    if (dto.dataScope === null) {
      nullFields.push('dataScope');
    }
    if (nullFields.length > 0) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        `${nullFields.join('、')} 不能为 null`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const nextCode = dto.code === undefined ? current.code : dto.code;
    if (nextCode !== current.code) {
      await this.assertCodeAvailable(nextCode, id);
    }

    try {
      const updated = await this.repository.update(id, {
        name: dto.name,
        code: nextCode,
        ...(dto.dataScope === undefined ? {} : { dataScope: dto.dataScope }),
        ...(dto.status === undefined ? {} : { status: dto.status }),
        ...(dto.remark === undefined ? {} : { remark: dto.remark }),
      });

      // R10 ②：update 也能改 status，而 status 决定这个角色的成员当下有没有权限码。
      // 漏了这一步 = 停用角色后其成员仍持有上一版权限码，直到缓存 TTL 到期。
      // 与 updateStatus 同一条规则：**值发生变化才清**，设成同值只是一次无谓的缓存抖动。
      if (current.status !== (dto.status ?? current.status)) {
        const userIds = await this.repository.findUserIdsByRoleId(id);
        await this.clearCachesFor(userIds);
      }

      return toRoleResponse(updated);
    } catch (error) {
      this.rethrowIfCodeTaken(error);
      throw error;
    }
  }

  /**
   * 删除角色：**不**拒绝「还有成员」——spec 第 5 节的策略是同一事务里
   * 物理清掉两张连接行，等于把这个角色从所有持有者身上摘掉（fail-closed：
   * 少一个角色的权限，不会多）。dept 的「有用户就拒绝」是 dept 的规则。
   */
  async remove(id: bigint): Promise<void> {
    await this.assertExists(id);

    // 受影响用户必须在清连接表**之前**查——deleteWithRefs 一跑就查不到了（R10 ⑥）
    const userIds = await this.repository.findUserIdsByRoleId(id);

    await this.repository.deleteWithRefs(id);

    await this.clearCachesFor(userIds);
  }

  async updateStatus(
    id: bigint,
    dto: UpdateRoleStatusDto,
  ): Promise<RoleResponseDto> {
    const current = await this.repository.findById(id);
    if (current === null) {
      this.notFound();
    }

    const updated = await this.repository.update(id, {
      name: current.name,
      status: dto.status,
    });

    // R10 ②：**值发生变化**才清。设成同值不改变「谁有哪些权限码」，
    // 清了只是一次无谓的缓存抖动。
    if (current.status !== dto.status) {
      const userIds = await this.repository.findUserIdsByRoleId(id);
      await this.clearCachesFor(userIds);
    }

    return toRoleResponse(updated);
  }

  /**
   * 全量覆盖式分配权限（spec 第 8 节「分配类接口一律全量覆盖」）：
   * 请求里的集合就是目标，Service 做差集——缺的新增、多的物理删除。
   * 不做增量接口：前端要同时管增删两个接口、还要处理"加一个已经有的"
   * 这类幂等场景，而服务端的存储过程是同一段代码。
   */
  async assignPermissions(
    id: bigint,
    dto: AssignRolePermissionsDto,
  ): Promise<RoleDetailResponseDto> {
    await this.assertExists(id);

    // 数组里的重复 ID 去重——集合没有重复元素，重复输入是笔误而不是错误
    const targetIds = [...new Set(dto.permissionIds.map((raw) => BigInt(raw)))];

    // 每个都必须存在。用权限模块的 assertExists：错误码归权限段（23101），
    // 与 R13 括号里「写操作的 roleId 走 22101」是同一条原则。
    for (const permissionId of targetIds) {
      await this.permissions.assertExists(permissionId);
    }

    const currentIds = await this.repository.findPermissionIdsByRoleId(id);
    const currentSet = new Set(currentIds.map((value) => value.toString()));
    const targetSet = new Set(targetIds.map((value) => value.toString()));

    const toAdd = targetIds.filter(
      (value) => !currentSet.has(value.toString()),
    );
    const toRemove = currentIds.filter(
      (value) => !targetSet.has(value.toString()),
    );

    await this.repository.replacePermissions(id, toAdd, toRemove);

    // R10 ①：改的是角色→权限，清的是持有该角色的所有用户
    const userIds = await this.repository.findUserIdsByRoleId(id);
    await this.clearCachesFor(userIds);

    return toRoleDetailResponse(await this.mustFind(id), targetIds);
  }

  private async mustFind(id: bigint): Promise<SysRole> {
    const entity = await this.repository.findById(id);
    if (entity === null) {
      this.notFound();
    }
    return entity;
  }

  /** 「角色不存在」只此一处定义 */
  private notFound(): never {
    throw new BusinessException(
      ErrorCode.ROLE_NOT_FOUND,
      '角色不存在',
      HttpStatus.NOT_FOUND,
    );
  }

  private async assertCodeAvailable(
    code: string,
    excludeId?: bigint,
  ): Promise<void> {
    const taken = await this.repository.existsByCode(code, excludeId);
    if (taken) {
      throw this.codeTaken();
    }
  }

  /**
   * DB-11 的 uk_sys_role_code_active 是并发兜底；P2002 换成本模块的 22102
   * （同 permission.service.ts 的 rethrowIfCodeTaken：10006 对「编码已存在」不对症）。
   * sys_role 的业务唯一键只有 code_active 一个。
   */
  private rethrowIfCodeTaken(error: unknown): void {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw this.codeTaken();
    }
  }

  private codeTaken(): BusinessException {
    return new BusinessException(
      ErrorCode.ROLE_CODE_TAKEN,
      '角色编码已存在',
      HttpStatus.CONFLICT,
    );
  }

  private async clearCachesFor(userIds: bigint[]): Promise<void> {
    if (userIds.length > 0) {
      await this.sessions.clearPermissions(userIds);
    }
  }
}
