import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type SysPermission } from '@prisma/client';
import { ErrorCode } from '../../common/constants/error-code';
import { BusinessException } from '../../common/errors/business.exception';
import { SessionStore } from '../../infra/redis/session-store.service';
import { PermissionRepository } from './permission.repository';
import { toPermissionResponse, toPermissionTree } from './permission.mapper';
import type { PermissionType } from './permission.constants';
import type { PermissionResponseDto } from './dto/permission-response.dto';
import type { PermissionTreeResponseDto } from './dto/permission-tree-response.dto';
import type { CreatePermissionDto } from './dto/create-permission.dto';
import type { UpdatePermissionDto } from './dto/update-permission.dto';

@Injectable()
export class PermissionService {
  constructor(
    private readonly repository: PermissionRepository,
    private readonly sessions: SessionStore,
  ) {}

  /** 供认证链路取权限码（登录、守卫缓存未命中）。**不走缓存**，缓存在 PermissionCacheService */
  async findCodesByUserId(userId: bigint): Promise<readonly string[]> {
    return this.repository.findCodesByUserId(userId);
  }

  /** 系统里全部启用的权限码；超管的 profile 用它当 permissions 集合 */
  async findAllCodes(): Promise<readonly string[]> {
    return this.repository.findAllCodes();
  }

  /**
   * 按给定的权限码集合裁出**可渲染的菜单树**（`GET /auth/profile` 的侧边栏）。
   *
   * 与 findTree() 是两个语义，不是同一个方法加个参数：
   * ① 去掉 BUTTON——侧边栏不渲染按钮，按钮的显隐由前端拿 permissions 自己判；
   * ② 只留 codes 命中的节点，但**保留它们的祖先**（哪怕祖先自己没被授予）——
   *    否则只拿到叶子菜单的用户会得到一串没有父级的孤节点，前端无从分组。
   *    祖先只作骨架：BUTTON 不入骨架，它的子节点挂到再上一层（见下面的挂接修正）。
   *
   * 传空集合返回空数组（一个角色都没有的用户侧边栏就是空的，这是对的）。
   */
  async findMenuTreeByCodes(
    codes: readonly string[],
  ): Promise<PermissionTreeResponseDto[]> {
    const all = await this.repository.findMany();
    const byId = new Map<string, SysPermission>();
    for (const entity of all) {
      byId.set(entity.id.toString(), entity);
    }

    const granted = new Set(codes);
    const retained = new Set<string>();

    for (const entity of all) {
      // code 为 null（DIR 节点，R8：目录不设码）时不可能命中 granted，
      // 它只会作为祖先骨架被保留——所以 null 在这里直接跳过是对的语义
      if (
        entity.type === 'BUTTON' ||
        entity.code === null ||
        !granted.has(entity.code)
      ) {
        continue;
      }

      retained.add(entity.id.toString());

      // 祖先链：只加非 BUTTON 的节点作骨架；遇到已保留的就停（不会再往上漏）
      let cursor: SysPermission | undefined =
        entity.parentId === null
          ? undefined
          : byId.get(entity.parentId.toString());
      while (cursor !== undefined) {
        const key = cursor.id.toString();
        if (retained.has(key)) {
          break;
        }
        if (cursor.type !== 'BUTTON') {
          retained.add(key);
        }
        cursor =
          cursor.parentId === null
            ? undefined
            : byId.get(cursor.parentId.toString());
      }
    }

    // 挂接修正：上面只把「BUTTON 的子节点」记进了 retained，没改它们的 parentId。
    // toPermissionTree 的判据是「parentId 在不在节点表里」，不在就提升为根——
    // 不重写的话 A→B(BUTTON)→C（只授 C）会输出 [A, C] 两个根，
    // 而不是 A 带着子节点 C，正好落进它自己要避免的「无从分组的孤节点」。
    // 所以每个保留节点的 parentId 都要指向**最近的保留非 BUTTON 祖先**，没有就置 null。
    const retainedEntities = all.filter((entity) =>
      retained.has(entity.id.toString()),
    );
    const rewired = retainedEntities.map((entity) => {
      let cursor: SysPermission | undefined =
        entity.parentId === null
          ? undefined
          : byId.get(entity.parentId.toString());
      while (cursor !== undefined) {
        if (cursor.type !== 'BUTTON' && retained.has(cursor.id.toString())) {
          break;
        }
        cursor =
          cursor.parentId === null
            ? undefined
            : byId.get(cursor.parentId.toString());
      }
      const nextParentId = cursor === undefined ? null : cursor.id;
      return entity.parentId === nextParentId
        ? entity
        : { ...entity, parentId: nextParentId };
    });

    return toPermissionTree(rewired);
  }

  /** 供其他模块校验权限点存在；Task 4 的角色分配接口会用到 */
  async assertExists(id: bigint): Promise<void> {
    const exists = await this.repository.findById(id);
    if (exists === null) {
      this.notFound();
    }
  }

  async findTree(): Promise<PermissionTreeResponseDto[]> {
    const entities = await this.repository.findMany();
    const tree = toPermissionTree(entities);

    // 判据同 dept：从根可达的节点数 < 实体数 ⇒ 有环（游离环会被静默丢掉）
    if (this.countReachable(tree) < entities.length) {
      throw new BusinessException(
        ErrorCode.INTERNAL_ERROR,
        '权限点数据存在环，无法构建权限树',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return tree;
  }

  private countReachable(nodes: PermissionTreeResponseDto[]): number {
    let count = 0;
    for (const node of nodes) {
      count += 1 + this.countReachable(node.children);
    }
    return count;
  }

  async findOne(id: bigint): Promise<PermissionResponseDto> {
    const entity = await this.repository.findById(id);
    if (entity === null) {
      this.notFound();
    }
    return toPermissionResponse(entity);
  }

  /** 「权限点不存在」只此一处定义 */
  private notFound(): never {
    throw new BusinessException(
      ErrorCode.PERMISSION_NOT_FOUND,
      '权限点不存在',
      HttpStatus.NOT_FOUND,
    );
  }

  async create(dto: CreatePermissionDto): Promise<PermissionResponseDto> {
    const parentId =
      dto.parentId === undefined || dto.parentId === null
        ? null
        : BigInt(dto.parentId);
    const code = this.normalizeOptional(dto.code);

    this.assertTypeCodeConsistent(dto.type, code);

    if (parentId !== null) {
      await this.assertExists(parentId);
    }
    if (code !== null) {
      await this.assertCodeAvailable(code);
    }

    try {
      const created = await this.repository.create({
        parentId,
        type: dto.type,
        code,
        name: dto.name,
        path: this.normalizeOptional(dto.path),
        component: this.normalizeOptional(dto.component),
        icon: this.normalizeOptional(dto.icon),
        sortOrder: dto.sortOrder ?? 0,
        status: dto.status ?? 1,
      });
      return toPermissionResponse(created);
    } catch (error) {
      this.rethrowIfCodeTaken(error);
      throw error;
    }
  }

  async update(
    id: bigint,
    dto: UpdatePermissionDto,
  ): Promise<PermissionResponseDto> {
    const current = await this.repository.findById(id);
    if (current === null) {
      this.notFound();
    }

    // PartialType 的 @IsOptional() 挡不住 null（同 dept.service.ts update()）
    const nullFields: string[] = [];
    if (dto.type === null) {
      nullFields.push('type');
    }
    if (dto.sortOrder === null) {
      nullFields.push('sortOrder');
    }
    if (dto.status === null) {
      nullFields.push('status');
    }
    if (nullFields.length > 0) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        `${nullFields.join('、')} 不能为 null`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const nextParentId =
      dto.parentId === undefined
        ? current.parentId
        : dto.parentId === null
          ? null
          : BigInt(dto.parentId);
    const nextType = dto.type ?? (current.type as PermissionType);
    const nextCode =
      dto.code === undefined ? current.code : this.normalizeOptional(dto.code);
    const nextStatus = dto.status ?? current.status;

    // R8：判**改完之后**的形态——只改 type、不传 code 时也一样
    this.assertTypeCodeConsistent(nextType, nextCode);

    if (nextParentId !== null && nextParentId !== current.parentId) {
      if (nextParentId === id) {
        throw this.parentInvalid('上级权限点不能是自己');
      }
      await this.assertExists(nextParentId);
      const ancestors = await this.repository.findAncestorIds(nextParentId);
      if (ancestors.some((ancestor) => ancestor === id)) {
        throw this.parentInvalid('上级权限点不能是自己的下级');
      }
    }

    if (nextCode !== null && nextCode !== current.code) {
      await this.assertCodeAvailable(nextCode, id);
    }

    let updated: SysPermission;
    try {
      updated = await this.repository.update(id, {
        name: dto.name,
        parentId: nextParentId,
        type: nextType,
        code: nextCode,
        ...(dto.path === undefined
          ? {}
          : { path: this.normalizeOptional(dto.path) }),
        ...(dto.component === undefined
          ? {}
          : { component: this.normalizeOptional(dto.component) }),
        ...(dto.icon === undefined
          ? {}
          : { icon: this.normalizeOptional(dto.icon) }),
        ...(dto.sortOrder === undefined ? {} : { sortOrder: dto.sortOrder }),
        ...(dto.status === undefined ? {} : { status: dto.status }),
      });
    } catch (error) {
      this.rethrowIfCodeTaken(error);
      throw error;
    }

    // R10 ⑤：code 或 status 变化 ⇒「谁有哪些权限码」变了，缓存必须作废
    if (current.code !== nextCode || current.status !== nextStatus) {
      const userIds = await this.repository.findUserIdsByPermissionId(id);
      await this.clearCachesFor(userIds);
    }

    return toPermissionResponse(updated);
  }

  async remove(id: bigint): Promise<void> {
    const current = await this.repository.findById(id);
    if (current === null) {
      this.notFound();
    }

    const childCount = await this.repository.countByParentId(id);
    if (childCount > 0) {
      throw new BusinessException(
        ErrorCode.PERMISSION_HAS_CHILDREN,
        `该权限点下还有 ${childCount} 个下级，请先移走或删除`,
        HttpStatus.CONFLICT,
      );
    }

    // 受影响用户必须在清连接表**之前**查——deleteWithRoleRefs 一跑，
    // 「谁持有过它」就再也查不出来了（R10 ④ 的注释）
    const userIds = await this.repository.findUserIdsByPermissionId(id);

    await this.repository.deleteWithRoleRefs(id);

    await this.clearCachesFor(userIds);
  }

  /**
   * R8 的类型↔码规则**只在这里判**，DTO 不写 @ValidateIf：
   * 同一条规则两处编码必然漂移，且 DTO 路径只会回 10001，让 23103/23104
   * 变成只在「update 只改 type」时才触发的半死码。
   */
  private assertTypeCodeConsistent(
    type: PermissionType,
    code: string | null,
  ): void {
    if (type === 'DIR') {
      if (code !== null) {
        throw new BusinessException(
          ErrorCode.PERMISSION_CODE_FORBIDDEN,
          '目录类型不能设置权限码',
          HttpStatus.BAD_REQUEST,
        );
      }
      return;
    }

    if (code === null) {
      throw new BusinessException(
        ErrorCode.PERMISSION_CODE_REQUIRED,
        '菜单与按钮类型必须设置权限码',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /** undefined / null / 空串都归约成 null——库里「没有值」只有一种写法 */
  private normalizeOptional(value: string | null | undefined): string | null {
    return value === undefined || value === null || value === '' ? null : value;
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
   * DB-11 的软删感知唯一键是并发下的兜底：Service 预检只是给好文案的快路径。
   * 两个请求同时写同一 code 时预检都过、库键拦下后来者（P2002），
   * 而 all-exceptions.filter 会把它映射成 409 `10006 数据冲突`——对「权限码已存在」
   * 既不对症也教不会使用者改什么，所以这里换成本模块的 23102。
   * sys_permission 的业务唯一键只有 code_active 一个，P2002 只可能是它。
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
      ErrorCode.PERMISSION_CODE_TAKEN,
      '权限码已存在',
      HttpStatus.CONFLICT,
    );
  }

  private parentInvalid(message: string): BusinessException {
    return new BusinessException(
      ErrorCode.PERMISSION_PARENT_INVALID,
      message,
      HttpStatus.BAD_REQUEST,
    );
  }

  private async clearCachesFor(userIds: bigint[]): Promise<void> {
    if (userIds.length > 0) {
      await this.sessions.clearPermissions(userIds);
    }
  }
}
