import { csvEscape, csvFilename, csvLine } from './csv.writer';

/**
 * CSV 转义（P4 Task 50 / R60 / R61）。
 *
 * 两条最容易漏的：**注入防护**（`=1+1` 会被 Excel 当公式）与
 * **ASCII 文件名**（非 ASCII 要走 RFC 5987，写错就是头注入面）。
 */
describe('csvEscape', () => {
  it('普通字段原样输出', () => {
    expect(csvEscape('导师甲')).toBe('导师甲');
    expect(csvEscape(42)).toBe('42');
  });

  it('含逗号 / 引号 / 换行的字段用双引号包裹，内部引号翻倍', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('a"b')).toBe('"a""b"');
    expect(csvEscape('a\nb')).toBe('"a\nb"');
    expect(csvEscape('a\rb')).toBe('"a\rb"');
  });

  it('null / undefined → 空串', () => {
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });

  it('公式前缀被前置单引号（CSV 注入防护）', () => {
    expect(csvEscape('=1+1')).toBe("'=1+1");
    expect(csvEscape('+86')).toBe("'+86");
    expect(csvEscape('-1')).toBe("'-1");
    expect(csvEscape('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('注入防护与引号包裹可以叠加', () => {
    expect(csvEscape('=A1,B1')).toBe(`"'=A1,B1"`);
  });

  it('Date → `YYYY-MM-DD HH:mm:ss`（UTC）', () => {
    expect(csvEscape(new Date('2026-11-02T03:04:05.000Z'))).toBe(
      '2026-11-02 03:04:05',
    );
  });
});

describe('csvLine', () => {
  it('按顺序拼接并逐格转义', () => {
    expect(csvLine(['a,b', 2, null])).toBe('"a,b",2,');
  });
});

describe('csvFilename', () => {
  it('`<resource>-<scope>-<yyyymmdd>.csv`，只含 ASCII', () => {
    const name = csvFilename(
      'mentor-stats',
      '2026',
      new Date('2026-11-02T00:00:00Z'),
    );
    expect(name).toBe('mentor-stats-2026-20261102.csv');
    expect(/^[A-Za-z0-9._-]+$/.test(name)).toBe(true);
  });

  it('非 ASCII / 带引号的 scope 一律回落成 `all`（不给头注入留口子）', () => {
    expect(
      csvFilename('x', '2026"; rm -rf /', new Date('2026-11-02T00:00:00Z')),
    ).toBe('x-all-20261102.csv');
  });
});
