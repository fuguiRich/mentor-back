import type { MetricsSource } from './assessment.repository';
import type { ResolvedWeights } from './assessment.constants';
import {
  composeScore,
  computeMetrics,
  periodRange,
  scoreAchievement,
  scoreReview,
  scoreWorkload,
} from './assessment.metrics';

const WEIGHTS: ResolvedWeights = {
  review: 0.4,
  workload: 0.4,
  achievement: 0.2,
  normalized: false,
};

const TARGETS = { workloadTargetCount: 10, achievementTargetCount: 5 };

/** 桩：把边界值直接喂进来，不必起库 */
function stubSource(overrides: Partial<MetricsSource> = {}): MetricsSource {
  return {
    tallyReviews: jest.fn().mockResolvedValue({ count: 0, avg: null }),
    tallyGuidance: jest
      .fn()
      .mockResolvedValue({ count: 0, minutes: 0, students: 0 }),
    tallyAchievements: jest.fn().mockResolvedValue(0),
    ...overrides,
  };
}

describe('periodRange', () => {
  it('学期 YYYY-1 → [YYYY-01-01, YYYY-07-01) UTC', () => {
    expect(periodRange('2026-1')).toEqual({
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-07-01T00:00:00.000Z'),
    });
  });

  it('学期 YYYY-2 → [YYYY-07-01, (YYYY+1)-01-01) UTC', () => {
    expect(periodRange('2026-2')).toEqual({
      from: new Date('2026-07-01T00:00:00.000Z'),
      to: new Date('2027-01-01T00:00:00.000Z'),
    });
  });

  it('历史四位年份按全年只读兼容', () => {
    expect(periodRange('2026')).toEqual({
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2027-01-01T00:00:00.000Z'),
    });
  });

  it('非法学期 / 短年份 → 400 / 10001', () => {
    for (const bad of ['2026-3', '2026-2027-1', '26', '']) {
      expect(() => periodRange(bad)).toThrow('考核周期必须是 YYYY-S（S=1/2）');
    }
  });
});

describe('scoreReview', () => {
  it('无评价 → 0（不是满分，也不是 NaN）', () => {
    expect(scoreReview(null)).toBe(0);
  });

  it('5 分制换算成百分制：4.33 → 86.6', () => {
    expect(scoreReview(4.33)).toBe(86.6);
  });

  it('满分 5 → 100', () => {
    expect(scoreReview(5)).toBe(100);
  });
});

describe('scoreWorkload / scoreAchievement', () => {
  it('达到目标值 → 100', () => {
    expect(scoreWorkload(10, 10)).toBe(100);
    expect(scoreAchievement(5, 5)).toBe(100);
  });

  it('超过目标值 → 封顶 100（不出现 250 分）', () => {
    expect(scoreWorkload(25, 10)).toBe(100);
    expect(scoreAchievement(9, 5)).toBe(100);
  });

  it('未达标 → 按比例', () => {
    expect(scoreWorkload(3, 10)).toBe(30);
    expect(scoreAchievement(2, 5)).toBe(40);
  });

  it('目标值为 0 / 负数 → 不除零，按 1 处理（R49）', () => {
    expect(Number.isFinite(scoreWorkload(3, 0))).toBe(true);
    expect(scoreWorkload(3, 0)).toBe(100);
    expect(scoreWorkload(0, 0)).toBe(0);
    expect(scoreWorkload(3, -5)).toBe(100);
  });
});

describe('composeScore', () => {
  it('按权重加权并保留 2 位小数', () => {
    // 86.6×0.4 + 50×0.4 + 20×0.2 = 34.64 + 20 + 4 = 58.64
    expect(
      composeScore({ review: 86.6, workload: 50, achievement: 20 }, WEIGHTS),
    ).toBe(58.64);
  });

  it('三项全 0 → 0', () => {
    expect(
      composeScore({ review: 0, workload: 0, achievement: 0 }, WEIGHTS),
    ).toBe(0);
  });
});

describe('computeMetrics', () => {
  it('空集：reviewAvg 为 null、compositeScore 为 0（不是满分）', async () => {
    const source = stubSource();
    const metrics = await computeMetrics(
      source,
      BigInt(7),
      '2026',
      WEIGHTS,
      TARGETS,
    );

    expect(metrics).toEqual({
      reviewAvg: null,
      reviewCount: 0,
      guidanceCount: 0,
      guidanceMinutes: 0,
      studentCount: 0,
      achievementCount: 0,
      compositeScore: 0,
    });
  });

  it('有数据时各分项与总分都对得上', async () => {
    const source = stubSource({
      tallyReviews: jest.fn().mockResolvedValue({ count: 3, avg: 4.33 }),
      tallyGuidance: jest
        .fn()
        .mockResolvedValue({ count: 5, minutes: 300, students: 2 }),
      tallyAchievements: jest.fn().mockResolvedValue(1),
    });

    const metrics = await computeMetrics(
      source,
      BigInt(7),
      '2026',
      WEIGHTS,
      TARGETS,
    );

    expect(metrics).toMatchObject({
      reviewAvg: 4.33,
      reviewCount: 3,
      guidanceCount: 5,
      guidanceMinutes: 300,
      studentCount: 2,
      achievementCount: 1,
      // 86.6×0.4 + 50×0.4 + 20×0.2 = 58.64
      compositeScore: 58.64,
    });
  });

  it('区间是半开 [YYYY-01-01, (YYYY+1)-01-01)，三个数据源拿到同一对边界', async () => {
    const tallyReviews = jest.fn().mockResolvedValue({ count: 0, avg: null });
    const tallyGuidance = jest
      .fn()
      .mockResolvedValue({ count: 0, minutes: 0, students: 0 });
    const tallyAchievements = jest.fn().mockResolvedValue(0);

    await computeMetrics(
      { tallyReviews, tallyGuidance, tallyAchievements },
      BigInt(7),
      '2026',
      WEIGHTS,
      TARGETS,
    );

    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2027-01-01T00:00:00.000Z');
    expect(tallyReviews).toHaveBeenCalledWith(7n, from, to);
    expect(tallyGuidance).toHaveBeenCalledWith(7n, from, to);
    expect(tallyAchievements).toHaveBeenCalledWith(7n, from, to);
  });

  it('权重归一化后的值被真正用上（不是配置原值）', async () => {
    const normalized: ResolvedWeights = {
      review: 0.5,
      workload: 0.5,
      achievement: 0,
      normalized: true,
    };
    const source = stubSource({
      tallyReviews: jest.fn().mockResolvedValue({ count: 1, avg: 5 }),
    });

    const metrics = await computeMetrics(
      source,
      BigInt(7),
      '2026',
      normalized,
      TARGETS,
    );

    // 100×0.5 + 0×0.5 + 0×0 = 50
    expect(metrics.compositeScore).toBe(50);
  });
});
