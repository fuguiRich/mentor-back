import {
  addDays,
  dateColumnFromString,
  toDateOnlyString,
  todayInTimeZone,
} from './archive.time';

/**
 * 归档保留期的日期运算（P4 Task 52 / Task 53）。
 *
 * 「今天」必须按 `APP_TIMEZONE` 算（R31 同一口径）：北京时间 00:00–08:00
 * 之间，UTC 还是前一天——按 UTC 算清理会比预期晚一天。
 */
describe('archive.time', () => {
  it('todayInTimeZone：东八区跨日边界按本地日期算', () => {
    // 2026-11-01 16:00Z = 北京时间 2026-11-02 00:00
    expect(
      toDateOnlyString(
        todayInTimeZone(new Date('2026-11-01T16:00:00.000Z'), 'Asia/Shanghai'),
      ),
    ).toBe('2026-11-02');
    // 前一刻仍是北京时间 11-01
    expect(
      toDateOnlyString(
        todayInTimeZone(new Date('2026-11-01T15:59:59.999Z'), 'Asia/Shanghai'),
      ),
    ).toBe('2026-11-01');
  });

  it('addDays：跨月 / 跨年按日历日推进', () => {
    expect(
      toDateOnlyString(addDays(new Date('2026-12-31T00:00:00.000Z'), 1)),
    ).toBe('2027-01-01');
    expect(
      toDateOnlyString(addDays(new Date('2026-02-28T00:00:00.000Z'), 1)),
    ).toBe('2026-03-01');
  });

  it('dateColumnFromString：DATE 列按 UTC 零点落库', () => {
    expect(dateColumnFromString('2026-11-02').toISOString()).toBe(
      '2026-11-02T00:00:00.000Z',
    );
  });
});
