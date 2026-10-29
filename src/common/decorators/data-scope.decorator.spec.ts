import type { DataScopeCeiling } from '../constants/data-scope';
import { DataScope, dataScopeCeilingOf } from './data-scope.decorator';

// ── 探针类：方法声明 / 类声明 / 都不声明三种情形 ──────────────────────────
class UndeclaredProbe {
  plain(): void {
    /* 什么都不挂 */
  }
}

@DataScope('dept')
class ClassLevelProbe {
  plain(): void {
    /* 类级上限 */
  }

  @DataScope('self')
  methodWins(): void {
    /* 方法级优先于类级 */
  }
}

class MethodLevelProbe {
  @DataScope('all')
  wide(): void {
    /* 只有方法级 */
  }
}

/**
 * 取原型上的原函数当 handler——元数据就挂在它身上。
 * 走 descriptor 而不是 `X.prototype.plain`：后者是「方法引用」，
 * unbound-method 会拦（那条规则对这里不适用，但也不必关规则）。
 */
function handlerOf(
  proto: object,
  name: string,
): (...args: unknown[]) => unknown {
  return Object.getOwnPropertyDescriptor(proto, name)?.value as (
    ...args: unknown[]
  ) => unknown;
}

/** 与拦截器同构：handler 是 descriptor.value，controller 是类本身（ctx.getClass()） */
function ceilingOf(
  proto: object,
  method: string,
  controller: unknown,
): DataScopeCeiling {
  return dataScopeCeilingOf(handlerOf(proto, method), controller);
}

describe('dataScopeCeilingOf', () => {
  it('判据 6：未声明 → 回落 self（不是 all——忘了写 = 全校可见是禁止的默认）', () => {
    expect(ceilingOf(UndeclaredProbe.prototype, 'plain', UndeclaredProbe)).toBe(
      'self',
    );
  });

  it('判据 6：只声明在方法上 → 取方法的值', () => {
    expect(
      ceilingOf(MethodLevelProbe.prototype, 'wide', MethodLevelProbe),
    ).toBe('all');
  });

  it('判据 6：只声明在类上 → 取类的值', () => {
    expect(ceilingOf(ClassLevelProbe.prototype, 'plain', ClassLevelProbe)).toBe(
      'dept',
    );
  });

  it('判据 6：方法声明优先于类声明', () => {
    // 类说 dept，方法说 self → 方法赢
    expect(
      ceilingOf(ClassLevelProbe.prototype, 'methodWins', ClassLevelProbe),
    ).toBe('self');
  });
});
