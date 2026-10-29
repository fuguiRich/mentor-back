import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../../common/constants/error-code';
import type { ConfigRepository } from './config.repository';
import { ConfigService } from './config.service';
import type { UpdateConfigDto } from './dto/config.dto';

interface Row {
  id: bigint;
  code: string;
  name: string;
  value: string;
  valueType: string;
  status: number;
  remark: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: bigint;
  updatedBy: bigint;
  deletedAt: Date | null;
  deletedBy: bigint | null;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 1n,
    code: 'site.title',
    name: '站点标题',
    value: 'hello',
    valueType: 'string',
    status: 1,
    remark: null,
    createdAt: new Date('2026-10-20T00:00:00.000Z'),
    updatedAt: new Date('2026-10-20T00:00:00.000Z'),
    createdBy: 1n,
    updatedBy: 1n,
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  };
}

function build(
  existing: Partial<Row> = {},
  byCode?: Partial<Row> | null,
): {
  service: ConfigService;
  updates: Record<string, unknown>[];
} {
  const updates: Record<string, unknown>[] = [];
  const repository = {
    findById: (id: bigint): Promise<Row | null> =>
      Promise.resolve(id === 1n ? row(existing) : null),
    findByCode: (): Promise<Row | null> =>
      Promise.resolve(byCode == null ? null : row(byCode)),
    existsByCode: (): Promise<boolean> => Promise.resolve(false),
    findMany: (): Promise<{ rows: Row[]; total: number }> =>
      Promise.resolve({ rows: [], total: 0 }),
    create: (): Promise<Row> => Promise.resolve(row()),
    update: (_id: bigint, data: Record<string, unknown>): Promise<Row> => {
      updates.push(data);
      return Promise.resolve(row({ ...existing, ...data }));
    },
    softDelete: (): Promise<void> => Promise.resolve(),
  } as unknown as ConfigRepository;
  return { service: new ConfigService(repository), updates };
}

describe('ConfigService', () => {
  it('1. create 值与类型不符 → 26104', async () => {
    const { service } = build();
    await expect(
      service.create({
        code: 'a.b',
        name: 'n',
        value: 'yes',
        valueType: 'boolean',
      }),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.CONFIG_VALUE_MISMATCH },
    });
  });

  it('2. create 值类型不在四个里 → 26103（不是 26104）', async () => {
    // 两个码要分得开：一个是「类型名写错了」，一个是「值跟类型对不上」。
    //
    // 这里走的是**服务层**：HTTP 上 valueType 的取值范围归 class-validator 的
    // @IsIn，传 'yaml' 在管道就变成 10001 了，轮不到 26103。别为了「让这条
    // 在 e2e 里也成立」去删 DTO 上的 @IsIn——26103 的真实入口是 update 不传
    // valueType 时拿库里那一列的脏类型名，那条路在 config.e2e-spec.ts 里。
    const { service } = build();
    await expect(
      service.create({ code: 'a.b', name: 'n', value: '1', valueType: 'yaml' }),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.CONFIG_VALUE_TYPE_INVALID },
    });
  });

  it('3. update 不传 valueType → 按**当前**类型校验新值（不是跳过）', async () => {
    // UpdateConfigDto 是 PUT 全量替换：name 与 value 必填，valueType 省略表示
    // 保持原值。这条是这个模块最容易长歪的地方——若拿「请求里的类型」
    // （undefined）去校验，任何脏值都能溜进来。红绿可伪：把 valueType
    // 填成 boolean 的行，发 value:'notabool' 必须 26104。
    const { service } = build({ valueType: 'boolean', value: 'true' });

    await expect(
      service.update(1n, { name: '站点标题', value: 'notabool' }),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.CONFIG_VALUE_MISMATCH },
    });
  });

  it('4. update 改了 valueType → 新值按**新**类型校验', async () => {
    const { service } = build({ valueType: 'string', value: 'abc' });

    await expect(
      service.update(1n, {
        name: '并发上限',
        value: 'not-a-number',
        valueType: 'number',
      }),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.CONFIG_VALUE_MISMATCH },
    });
  });

  it('4b. value 整个没给（绕过 DTO 校验的调用）→ 按库里现值校验，不 TypeError', async () => {
    // DTO 层挡得住 HTTP，但 service 的签名是 `string`，而实际入参可能
    // 是 undefined（脚本直调、测试桩、将来改成 PATCH）。曾在这里炸过
    // `Cannot read properties of undefined (reading 'trim')`——一行 500
    // 比 26104 难查得多。
    const { service } = build({ valueType: 'string', value: 'not-a-number' });

    await expect(
      service.update(1n, { valueType: 'number' } as unknown as UpdateConfigDto),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.CONFIG_VALUE_MISMATCH },
    });
  });

  it('5. update 传 null 打在 NOT NULL 列上 → 10002 / 400，不是 Prisma 的 500', async () => {
    const { service, updates } = build();

    await expect(
      service.update(1n, { valueType: null } as unknown as UpdateConfigDto),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.PARAM_INVALID },
      status: HttpStatus.BAD_REQUEST,
    });
    expect(updates).toHaveLength(0);
  });

  it('6. getNumber 遇到类型不是 number 的行 → 回默认值，不抛', async () => {
    const { service } = build({}, { valueType: 'string', value: 'abc' });

    await expect(service.getNumber('site.title', 7)).resolves.toBe(7);
  });

  it('7. getNumber 的值解析不出来 → 回默认值', async () => {
    // valueType 对但值脏（历史数据 / 手工改库）。Number('') 是 0 而不是 NaN，
    // 所以这里用 Number.isFinite 兜，别退化成「空值读出 0」。
    const { service } = build({}, { valueType: 'number', value: '  ' });

    await expect(service.getNumber('site.title', 7)).resolves.toBe(7);
  });

  it('8. getBoolean 只认 value === "true"；"1" 读成 false 但也不抛', async () => {
    const { service } = build({}, { valueType: 'boolean', value: 'true' });
    await expect(service.getBoolean('x', false)).resolves.toBe(true);

    const other = build({}, { valueType: 'boolean', value: 'false' });
    await expect(other.service.getBoolean('x', true)).resolves.toBe(false);
  });

  it('9. getString 取不到 → 回默认值', async () => {
    const { service } = build({}, null);
    await expect(service.getString('nope', 'fallback')).resolves.toBe(
      'fallback',
    );
  });

  it('10. findOne 不存在 → 26101 / 404', async () => {
    const { service } = build();
    await expect(service.findOne(9n)).rejects.toMatchObject({
      response: { code: ErrorCode.CONFIG_NOT_FOUND },
      status: HttpStatus.NOT_FOUND,
    });
  });
});
