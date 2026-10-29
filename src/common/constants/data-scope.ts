/**
 * 数据范围（组织级 / 行级）。
 *
 * 存成**字符串**而不是数字：`data_scope` 列里存的值会被读进日志、读进前端、
 * 读进排错现场，数字 2 在那三处都不自解释，字符串 `dept` 自解释。
 *
 * 宽窄顺序是本文件唯一的一处「业务判断」：一个用户持多个角色时取最宽的那个。
 * 反过来（取最窄）会让「多授一个角色反而看得更少」，没人会想到去查这个。
 */
export const DATA_SCOPES = ['all', 'deptAndChildren', 'dept', 'self'] as const;

export type DataScope = (typeof DATA_SCOPES)[number];

/** 由窄到宽。resolveEffectiveScope 用它取最大值 */
export const DATA_SCOPE_ORDER: Readonly<Record<DataScope, number>> = {
  self: 0,
  dept: 1,
  deptAndChildren: 2,
  all: 3,
};

/** 供 DTO 的 @IsIn 与 OpenAPI 的 enum 用 */
export const DATA_SCOPE_VALUES: readonly string[] = DATA_SCOPES;

export function isDataScope(value: string): value is DataScope {
  return (DATA_SCOPES as readonly string[]).includes(value);
}

export function resolveEffectiveScope(scopes: readonly DataScope[]): DataScope {
  let widest: DataScope = 'self';
  for (const scope of scopes) {
    if (DATA_SCOPE_ORDER[scope] > DATA_SCOPE_ORDER[widest]) {
      widest = scope;
    }
  }
  return widest;
}

/**
 * 解析出来的**行级过滤条件**。注意它不是权限判定——
 * 「这个人能不能点这个按钮」由 PermissionGuard 管，这里只回答「列表里该出现哪些行」。
 *
 * 它是过滤条件，不是权限：DataScopeService 算完之后由各 repository 自行翻译成
 * where 片段（sys_user 的 self 译成 `id = userId`，业务表的 self 译成
 * `created_by = userId`）。放在 common 而不是 data-scope 模块里，
 * 是因为 repository 要 import 这个类型，而 repository 反向依赖 service 是倒装的。
 */
export type DataScopeFilter =
  /** 不加行级约束 */
  | { kind: 'all' }
  /** 只看自己那一份。userId 是「自己」，各表对「自己」的译法不同 */
  | { kind: 'self'; userId: bigint }
  /**
   * 只看挂在这些部门下的行。
   * **空数组 = 一行都看不见**，不是「不限」——见 data-scope.service.ts 的回落说明。
   */
  | { kind: 'depts'; deptIds: bigint[] };

/**
 * 接口声明的**数据范围上限**（一个接口最多放多宽），挂在 `@DataScope` 装饰器上。
 *
 * ## 三套词对照——同名异义，不许合并
 *
 * | 词 | 取值 | 存在哪 | 干什么 |
 * | --- | --- | --- | --- |
 * | `DataScope`（A，库里的） | `'all' \| 'deptAndChildren' \| 'dept' \| 'self'` | `sys_role.data_scope` 列 | 一个**角色**持有多宽 |
 * | `DataScopeFilter`（B，解析结果） | `{kind:'all'} \| {kind:'self'} \| {kind:'depts'}` | 不落库，请求内 | 落到 where 的**行级过滤** |
 * | `DataScopeCeiling`（C，本词表） | `'self' \| 'dept' \| 'all'` | 装饰器元数据 | 一个**接口**最多放多宽 |
 *
 * **C 的 `'dept'` 与 A 的 `'dept'` 同名不同义**：
 * C 的 `'dept'` 是上限「本部门**及下级**」（对齐 A 的 `deptAndChildren`，见
 * {@link CEILING_TO_SCOPE}）；A 的 `'dept'` 是「**仅**本部门」。
 * `college_admin` 的 `data_scope` 是 A 的 `deptAndChildren`，而 `@DataScope('dept')`
 * 译过去也是 `deptAndChildren`；窄的那个（A 的 `'dept'`）在 {@link clampDataScope}
 * 求窄时自然保留，不会被顶宽。
 *
 * **为什么 C 不直接用 A 的四值**：C 说的是「这个接口**不许**超过哪里」，
 * 而「仅本部门」这种上限现在没有用武之地（现有读接口要么全给、要么只给自己），
 * 造一个用不上的第四个上限值是提前付钱。代价就是上面那处同名异义——
 * 所以本类型必须起名 `DataScopeCeiling`（**不许**叫 `DataScope`，会撞名）。
 */
export const DATA_SCOPE_CEILINGS = ['self', 'dept', 'all'] as const;

export type DataScopeCeiling = (typeof DATA_SCOPE_CEILINGS)[number];

/** 接口上限译成「角色范围」那一套（A），才能与角色范围求窄 */
export const CEILING_TO_SCOPE: Readonly<Record<DataScopeCeiling, DataScope>> = {
  self: 'self',
  // ← 注意：C 的 'dept' = 「本部门**及下级**」，对齐 A 的 deptAndChildren，
  //   不是 A 的 'dept'（仅本部门）。同名异义，见 DataScopeCeiling 的 JSDoc。
  dept: 'deptAndChildren',
  all: 'all',
};

/**
 * 角色范围与接口上限**求窄**（不是求宽）：取 `DATA_SCOPE_ORDER` 小的那个。
 *
 * 写反了（取大）就等于上限形同虚设——`@DataScope('self')` 的接口会被
 * `all` 的角色撑成全校可见，这是本映射最可能写错的一行。
 */
export function clampDataScope(
  effective: DataScope,
  ceiling: DataScopeCeiling,
): DataScope {
  const ceilingScope = CEILING_TO_SCOPE[ceiling];
  return DATA_SCOPE_ORDER[effective] <= DATA_SCOPE_ORDER[ceilingScope]
    ? effective
    : ceilingScope;
}

/**
 * 目标部门在不在这个过滤条件的可见范围内。
 * `{kind:'depts'}` 看 deptIds 是否含它；`'self'` 恒 false；`'all'` 恒 true。
 *
 * `'self'` 恒 false 是有意的：self 过滤器里根本没有部门维度，
 * 「自己恰好挂在这个部门」不等于「有权按这个部门筛」——那是越权校验，
 * 不是行过滤求交。求交会把「越权」蒙混成「空列表」。
 */
export function isDeptInFilter(
  filter: DataScopeFilter,
  deptId: bigint,
): boolean {
  if (filter.kind === 'all') {
    return true;
  }
  if (filter.kind === 'self') {
    return false;
  }
  return filter.deptIds.some((id) => id === deptId);
}
