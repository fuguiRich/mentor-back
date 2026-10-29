import { validate } from 'class-validator';
import { IsBigIntId } from './is-bigint-id.decorator';

class ProbeDto {
  @IsBigIntId()
  id?: unknown;
}

async function errorCountFor(value: unknown): Promise<number> {
  const probe = new ProbeDto();
  probe.id = value;

  const errors = await validate(probe);

  return errors.length;
}

describe('IsBigIntId', () => {
  it.each(['0', '1', '007', '9223372036854775807'])(
    '接受合法 ID %s',
    async (value) => {
      expect(await errorCountFor(value)).toBe(0);
    },
  );

  it.each([
    '1.5',
    '1.0',
    '.5',
    '-1',
    '+1',
    '1e3',
    'abc',
    '',
    '9223372036854775808',
    '18446744073709551615',
    123,
    null,
    undefined,
  ])('拒绝非法 ID %s', async (value) => {
    expect(await errorCountFor(value)).toBe(1);
  });
});

class ProbeListDto {
  @IsBigIntId({ each: true })
  ids?: unknown;
}

async function listErrorCountFor(value: unknown): Promise<number> {
  const probe = new ProbeListDto();
  probe.ids = value;

  return (await validate(probe)).length;
}

describe('IsBigIntId（数组）', () => {
  it('接受合法 ID 数组（含空数组——「清空」是合法目标集合）', async () => {
    expect(await listErrorCountFor(['1', '2', '9223372036854775807'])).toBe(0);
    expect(await listErrorCountFor([])).toBe(0);
  });

  it('数组里有一个非法元素即整体拒绝', async () => {
    expect(await listErrorCountFor(['1', 'abc'])).toBe(1);
    expect(await listErrorCountFor(['1', '1.5'])).toBe(1);
    expect(await listErrorCountFor(['1', '9223372036854775808'])).toBe(1);
  });

  it('非数组值仍按单值判据（原有行为不变）', async () => {
    expect(await listErrorCountFor('12')).toBe(0);
    expect(await listErrorCountFor(12)).toBe(1);
    expect(await listErrorCountFor(null)).toBe(1);
  });
});
