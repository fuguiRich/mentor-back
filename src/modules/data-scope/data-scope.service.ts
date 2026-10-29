import { HttpStatus, Injectable } from '@nestjs/common';
import {
  clampDataScope,
  isDataScope,
  isDeptInFilter,
  resolveEffectiveScope,
  type DataScope,
  type DataScopeCeiling,
  type DataScopeFilter,
} from '../../common/constants/data-scope';
import { ErrorCode } from '../../common/constants/error-code';
import { BusinessException } from '../../common/errors/business.exception';
import { DeptRepository } from '../dept/dept.repository';
import { RoleRepository } from '../role/role.repository';

export type { DataScopeFilter };

/**
 * 解析当前登录者的数据范围。
 *
 * 不注入 UserRepository 是**故意的**：UserModule 要用本服务过滤用户列表，
 * 而本服务再回头注入 UserRepository 就成了双向依赖（Nest 的 forwardRef 场景）。
 * 调用方手上本来就有自己的部门，把它当参数传进来，模块图就还是单向的。
 */
@Injectable()
export class DataScopeService {
  constructor(
    private readonly roles: RoleRepository,
    private readonly depts: DeptRepository,
  ) {}

  /**
   * 一个用户持多角色时取**最宽**的那个（data-scope.ts 的 resolveEffectiveScope）。
   * 取最窄会让「多授一个角色反而看得更少」，没人会想到去查这个。
   *
   * `ceiling` 是接口上限（`@DataScope` 声明、词表 C），**必填**——
   * 角色范围与它**求窄**（{@link clampDataScope}），不是求宽。
   * `ceiling === 'self'` 时不读 `actor.deptId`（调用方可传 null），
   * 不查角色、不查部门、不看 `isSuperAdmin`——上限是「接口不许超过哪里」，
   * 超管也不豁免。
   */
  async resolve(
    actor: {
      userId: bigint;
      isSuperAdmin: boolean;
      deptId: bigint | null;
    },
    ceiling: DataScopeCeiling,
  ): Promise<DataScopeFilter> {
    if (ceiling === 'self') {
      return { kind: 'self', userId: actor.userId };
    }

    // 超管的角色范围是 all——但仍要与 ceiling 求窄（超管不豁免上限）
    const effective = actor.isSuperAdmin
      ? 'all'
      : await this.resolveRoleScope(actor.userId);
    const clamped = clampDataScope(effective, ceiling);

    if (clamped === 'all') {
      return { kind: 'all' };
    }
    if (clamped === 'self') {
      return { kind: 'self', userId: actor.userId };
    }

    if (actor.deptId === null) {
      // 手里拿着部门级范围却没有部门：**回落到「一行都看不见」**，
      // 不是「全部」。权限解析的默认值只能往紧取——往松取的方向，
      // 一次配置错误就等于把全校数据交出去，且没有任何机制会报警。
      return { kind: 'depts', deptIds: [] };
    }

    if (clamped === 'dept') {
      return { kind: 'depts', deptIds: [actor.deptId] };
    }

    return {
      kind: 'depts',
      deptIds: [
        actor.deptId,
        ...(await this.depts.findDescendantIds(actor.deptId)),
      ],
    };
  }

  /**
   * 目标部门不在 filter 里 → 抛 {@link ErrorCode.FORBIDDEN}（10003）/ HTTP 403。
   *
   * **越权必须被拒**，不是返回空列表蒙混——否则前端分不清「没数据」和「没权限」。
   * 这是 `isDeptInFilter` 的抛错壳：判据在 Service 落地（R9），不散到各调用方。
   */
  assertDeptVisible(filter: DataScopeFilter, deptId: bigint): void {
    if (!isDeptInFilter(filter, deptId)) {
      throw new BusinessException(
        ErrorCode.FORBIDDEN,
        '无权限',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async resolveRoleScope(userId: bigint): Promise<DataScope> {
    const roleIds = await this.roles.findRoleIdsByUserId(userId);
    const rawScopes = await this.roles.findDataScopesByRoleIds(roleIds);
    return resolveEffectiveScope(rawScopes.filter(isDataScope));
  }
}
