import { IsDateBoundary } from './is-date-boundary.validator';

/** 造一个带 constraints 的 `ValidationArguments` 形状（只用到 property / constraints） */
function args(property: string, boundary?: 'future' | 'past'): never {
  return {
    property,
    constraints: boundary === undefined ? [] : [boundary],
  } as never;
}

describe('IsDateBoundary', () => {
  const validator = new IsDateBoundary();

  describe('future（严格 > now）', () => {
    it('未来时间通过', () => {
      expect(
        validator.validate(
          new Date(Date.now() + 60_000).toISOString(),
          args('requestedTime', 'future'),
        ),
      ).toBe(true);
    });

    it('过去时间不通过', () => {
      expect(
        validator.validate(
          new Date(Date.now() - 60_000).toISOString(),
          args('requestedTime', 'future'),
        ),
      ).toBe(false);
    });

    it('文案点名被校验的字段：requestedTime / proposedTime 各说各的', () => {
      expect(validator.defaultMessage(args('requestedTime', 'future'))).toBe(
        'requestedTime 必须晚于当前时间',
      );
      expect(validator.defaultMessage(args('proposedTime', 'future'))).toBe(
        'proposedTime 必须晚于当前时间',
      );
    });
  });

  describe('past（<= now，含等号）', () => {
    it('过去时间通过', () => {
      expect(
        validator.validate(
          new Date(Date.now() - 60_000).toISOString(),
          args('actualTime', 'past'),
        ),
      ).toBe(true);
    });

    it('未来时间不通过', () => {
      expect(
        validator.validate(
          new Date(Date.now() + 60_000).toISOString(),
          args('actualTime', 'past'),
        ),
      ).toBe(false);
    });

    it('文案点名被校验的字段', () => {
      expect(validator.defaultMessage(args('actualTime', 'past'))).toBe(
        'actualTime 不得晚于当前时间',
      );
    });
  });

  it('非字符串直接放行（格式交给 @IsString / @IsISO8601）', () => {
    expect(validator.validate(1_800_000_000_000, args('x', 'future'))).toBe(
      true,
    );
    expect(validator.validate(undefined, args('x', 'past'))).toBe(true);
  });
});
