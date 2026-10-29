import { ERROR_CODE_SEGMENTS, ErrorCode } from './error-code';

describe('ErrorCode', () => {
  const entries = Object.entries(ErrorCode).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number',
  );

  it('每个码都落在已登记的段位内', () => {
    for (const [name, code] of entries) {
      const inSegment = ERROR_CODE_SEGMENTS.some(
        ([start, end]) => code >= start && code <= end,
      );

      expect({ name, code, inSegment }).toEqual({
        name,
        code,
        inSegment: true,
      });
    }
  });

  it('全局唯一：没有两个名字共用同一个码', () => {
    const codes = entries.map(([, code]) => code);
    const unique = new Set(codes);

    expect(unique.size).toBe(codes.length);
  });

  it('段位之间互不重叠', () => {
    const sorted = [...ERROR_CODE_SEGMENTS].sort((a, b) => a[0] - b[0]);

    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i][0]).toBeGreaterThan(sorted[i - 1][1]);
    }
  });
});
