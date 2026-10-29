import {
  CEILING_TO_SCOPE,
  clampDataScope,
  isDeptInFilter,
  type DataScope,
  type DataScopeCeiling,
  type DataScopeFilter,
} from './data-scope';

describe('clampDataScope', () => {
  // 3×4 逐格钉死「求窄」。改反成取宽的话，左上角三格会先红。
  const GRID: [DataScopeCeiling, DataScope, DataScope][] = [
    // ceiling 'self' → 恒 'self'（上限把一切都压到最窄）
    ['self', 'all', 'self'],
    ['self', 'deptAndChildren', 'self'],
    ['self', 'dept', 'self'],
    ['self', 'self', 'self'],
    // ceiling 'dept' → 译作 A 的 deptAndChildren（本部门及下级），只能更窄不能更宽
    ['dept', 'all', 'deptAndChildren'],
    ['dept', 'deptAndChildren', 'deptAndChildren'],
    ['dept', 'dept', 'dept'],
    ['dept', 'self', 'self'],
    // ceiling 'all' → 不设上限，角色范围原样保留
    ['all', 'all', 'all'],
    ['all', 'deptAndChildren', 'deptAndChildren'],
    ['all', 'dept', 'dept'],
    ['all', 'self', 'self'],
  ];

  it.each(GRID)(
    'clamp(%s 上限, %s 范围) → %s',
    (ceiling, effective, expected) => {
      expect(clampDataScope(effective, ceiling)).toBe(expected);
    },
  );

  it('3×4 共 12 格——格数被人删了要在这里红', () => {
    expect(GRID).toHaveLength(12);
  });

  it("CEILING_TO_SCOPE['dept'] 是 deptAndChildren（C 的 dept = 本部门及下级，同名异义）", () => {
    expect(CEILING_TO_SCOPE.dept).toBe('deptAndChildren');
    expect(CEILING_TO_SCOPE.self).toBe('self');
    expect(CEILING_TO_SCOPE.all).toBe('all');
  });

  it('求窄不是求宽：上限 self 时，最宽的角色范围也只能到 self', () => {
    // 这是「写反了取宽」最直接的反例——期望值必须是 self
    expect(clampDataScope('all', 'self')).toBe('self');
  });
});

describe('isDeptInFilter', () => {
  it("kind:'all' 恒 true", () => {
    expect(isDeptInFilter({ kind: 'all' }, 5n)).toBe(true);
    expect(isDeptInFilter({ kind: 'all' }, 0n)).toBe(true);
  });

  it("kind:'self' 恒 false——自己那一行不等于有权按部门筛", () => {
    expect(isDeptInFilter({ kind: 'self', userId: 5n }, 5n)).toBe(false);
    expect(isDeptInFilter({ kind: 'self', userId: 5n }, 1n)).toBe(false);
  });

  it("kind:'depts' 看 deptIds 是否含它（bigint 逐值比较）", () => {
    const filter: DataScopeFilter = { kind: 'depts', deptIds: [3n, 7n] };
    expect(isDeptInFilter(filter, 3n)).toBe(true);
    expect(isDeptInFilter(filter, 7n)).toBe(true);
    expect(isDeptInFilter(filter, 4n)).toBe(false);
  });

  it("kind:'depts' 空数组 = 一行都看不见，任何部门都不在内", () => {
    expect(isDeptInFilter({ kind: 'depts', deptIds: [] }, 1n)).toBe(false);
  });
});
