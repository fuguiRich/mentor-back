import { SetMetadata } from '@nestjs/common';
import type { DataScopeCeiling } from '../constants/data-scope';

export const DATA_SCOPE_CEILING_KEY = 'dataScopeCeiling';

/**
 * 声明本接口的数据范围**上限**：调用者实际能看的范围，
 * 是「角色的 `data_scope`（库里的那套 A 值）」与本上限求窄后的结果。
 *
 * ## 同名异义——写死在这里，免得后来人合并成一个类型
 *
 * 本装饰器收的 `'self' | 'dept' | 'all'` 是 **上限**（`DataScopeCeiling`，词表 C）：
 * `'dept'` = 「本部门**及下级**」（对齐库里 `DataScope` 的 `'deptAndChildren'`）。
 * 而库里 `sys_role.data_scope` 的 `'dept'`（词表 A）是「**仅**本部门」——
 * 两者同名不同义。对照表见 `data-scope.ts` 的 `DataScopeCeiling` JSDoc，
 * C→A 的翻译写死在 `CEILING_TO_SCOPE`。类型不许叫 `DataScope`，会撞名。
 *
 * **参数必填**——不给默认值：「忘了写范围」要在编译期红，
 * 不是运行时静默。「不声明就收得最紧」靠 `dataScopeCeilingOf` 的回落值
 * `'self'` 与本条一起保证，不是靠一个默认参数。
 */
export function DataScope(
  ceiling: DataScopeCeiling,
): MethodDecorator & ClassDecorator {
  return SetMetadata(DATA_SCOPE_CEILING_KEY, ceiling);
}

/**
 * 取一个路由的数据范围上限：**方法 > 类 > `'self'`**。
 *
 * **未声明一律 `'self'`**——默认收得最紧，禁止默认放行（回落成 `'all'`
 * 就是「忘了写 = 全校可见」）。纯函数，可单测；拦截器只搬它的结果。
 */
export function dataScopeCeilingOf(
  handler: (...args: unknown[]) => unknown,
  controller: unknown,
): DataScopeCeiling {
  const onMethod = Reflect.getMetadata(DATA_SCOPE_CEILING_KEY, handler) as
    DataScopeCeiling | undefined;
  if (onMethod !== undefined) {
    return onMethod;
  }

  // controller 收 unknown（调用方拿的是 ctx.getClass()），Reflect 要 Object——
  // 类装饰器的元数据就挂在构造函数上，运行时一定是对象
  const onClass = Reflect.getMetadata(
    DATA_SCOPE_CEILING_KEY,
    controller as object,
  ) as DataScopeCeiling | undefined;
  return onClass ?? 'self';
}
