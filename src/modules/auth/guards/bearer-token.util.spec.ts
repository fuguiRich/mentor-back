import { extractBearerToken } from './bearer-token.util';

describe('extractBearerToken', () => {
  it.each<[string | undefined, string | null]>([
    ['Bearer abc', 'abc'],
    ['bearer abc', 'abc'],
    ['Bearer  abc', 'abc'],
    ['Basic abc', null],
    ['abc', null],
    ['', null],
    [undefined, null],
    ['Bearer ', null],
  ])('extractBearerToken(%p) → %p', (header, expected) => {
    expect(extractBearerToken(header)).toBe(expected);
  });
});
