import {
  ASSESSMENT_PERIOD_PATTERN,
  currentPeriod,
  resolveWeights,
  safeTargetCount,
} from './assessment.constants';

/**
 * 权重与周期口径（P3 Task 37 / R47 / R48 / R49）。
 *
 * 这几条是「配置错到无法计算」与「配置错但还能算」的分界线，必须逐条钉住：
 * 归一化静默放过会让偏差不可见，直接报错会让一次误配把考核整体卡死。
 */
describe('resolveWeights', () => {
  it('和为 1 时原样返回，normalized = false', () => {
    expect(
      resolveWeights({ review: 0.4, workload: 0.4, achievement: 0.2 }),
    ).toEqual({
      review: 0.4,
      workload: 0.4,
      achievement: 0.2,
      normalized: false,
    });
  });

  it('和不为 1 时按比例归一化，normalized = true', () => {
    expect(resolveWeights({ review: 1, workload: 1, achievement: 0 })).toEqual({
      review: 0.5,
      workload: 0.5,
      achievement: 0,
      normalized: true,
    });
  });

  it('归一化后三个值之和仍是 1（浮点容差内）', () => {
    const resolved = resolveWeights({
      review: 3,
      workload: 5,
      achievement: 2,
    });
    expect(
      resolved.review + resolved.workload + resolved.achievement,
    ).toBeCloseTo(1, 9);
    expect(resolved.normalized).toBe(true);
  });

  it('全 0 → 抛错（无法加权，不能当 0 处理）', () => {
    expect(() =>
      resolveWeights({ review: 0, workload: 0, achievement: 0 }),
    ).toThrow('考核权重配置非法');
  });

  it('含负数 → 抛错', () => {
    expect(() =>
      resolveWeights({ review: -1, workload: 1, achievement: 1 }),
    ).toThrow('考核权重配置非法');
  });

  it('含 NaN → 抛错（配置读成了空串 / 非数字时的真实形状）', () => {
    expect(() =>
      resolveWeights({ review: Number.NaN, workload: 1, achievement: 1 }),
    ).toThrow('考核权重配置非法');
  });

  it('单个值为 1、其余 0 是合法的（全部权重压在一项上）', () => {
    expect(resolveWeights({ review: 1, workload: 0, achievement: 0 })).toEqual({
      review: 1,
      workload: 0,
      achievement: 0,
      normalized: false,
    });
  });
});

describe('safeTargetCount', () => {
  it('正数原样返回', () => {
    expect(safeTargetCount(10)).toBe(10);
    expect(safeTargetCount(0.5)).toBe(0.5);
  });

  it('0 / 负数 / NaN 一律按 1 处理（避免除零）', () => {
    expect(safeTargetCount(0)).toBe(1);
    expect(safeTargetCount(-5)).toBe(1);
    expect(safeTargetCount(Number.NaN)).toBe(1);
    expect(safeTargetCount(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('ASSESSMENT_PERIOD_PATTERN', () => {
  it('只接受学期 YYYY-S（S=1/2）', () => {
    expect(ASSESSMENT_PERIOD_PATTERN.test('2026-1')).toBe(true);
    expect(ASSESSMENT_PERIOD_PATTERN.test('2026-2')).toBe(true);
    expect(ASSESSMENT_PERIOD_PATTERN.test('1999-1')).toBe(true);
  });

  it('四位年份、非法学期、短年份、带空格一律不接受', () => {
    for (const bad of [
      '2026',
      '2026-3',
      '2026-0',
      '2026-2027-1',
      '26',
      ' 2026-1',
      '2026-1 ',
    ]) {
      expect(ASSESSMENT_PERIOD_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe('currentPeriod', () => {
  it('UTC 上半年 → YYYY-1，下半年 → YYYY-2', () => {
    expect(currentPeriod(new Date('2026-06-30T23:59:59.999Z'))).toBe('2026-1');
    expect(currentPeriod(new Date('2026-07-01T00:00:00.000Z'))).toBe('2026-2');
    expect(currentPeriod(new Date('2026-12-31T23:59:59.999Z'))).toBe('2026-2');
    expect(currentPeriod(new Date('2027-01-01T00:00:00.000Z'))).toBe('2027-1');
  });
});
