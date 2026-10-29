import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../../common/constants/error-code';
import type { DictRepository } from './dict.repository';
import { DictService } from './dict.service';
import type { UpdateDictItemDto } from './dto/update-dict-item.dto';
import type { UpdateDictTypeDto } from './dto/update-dict-type.dto';

function typeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1n,
    code: 'gender',
    name: '性别',
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

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 10n,
    dictTypeId: 1n,
    label: '男',
    value: 'M',
    sortOrder: 0,
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

function build(overrides: Partial<Record<string, unknown>> = {}): {
  service: DictService;
  calls: string[];
  softDeletes: string[];
} {
  const calls: string[] = [];
  const softDeletes: string[] = [];
  const repository = {
    findTypeById: (id: bigint): Promise<unknown> => {
      calls.push(`findTypeById(${id.toString()})`);
      return Promise.resolve(
        'findTypeById' in overrides ? overrides.findTypeById : typeRow(),
      );
    },
    findItemById: (id: bigint): Promise<unknown> => {
      calls.push(`findItemById(${id.toString()})`);
      return Promise.resolve(
        'findItemById' in overrides ? overrides.findItemById : itemRow(),
      );
    },
    existsTypeByCode: (): Promise<boolean> => {
      calls.push('existsTypeByCode');
      return Promise.resolve(
        typeof overrides.existsTypeByCode === 'boolean'
          ? overrides.existsTypeByCode
          : false,
      );
    },
    existsItemByTypeAndValue: (): Promise<boolean> => {
      calls.push('existsItemByTypeAndValue');
      return Promise.resolve(
        typeof overrides.existsItemByTypeAndValue === 'boolean'
          ? overrides.existsItemByTypeAndValue
          : false,
      );
    },
    countItemsByTypeId: (): Promise<number> =>
      Promise.resolve(
        typeof overrides.countItemsByTypeId === 'number'
          ? overrides.countItemsByTypeId
          : 0,
      ),
    createType: (): Promise<unknown> => Promise.resolve(typeRow()),
    updateType: (): Promise<unknown> => Promise.resolve(typeRow()),
    createItem: (): Promise<unknown> => Promise.resolve(itemRow()),
    updateItem: (): Promise<unknown> => Promise.resolve(itemRow()),
    softDeleteType: (): Promise<void> => {
      softDeletes.push('type');
      return Promise.resolve();
    },
    softDeleteItem: (): Promise<void> => {
      softDeletes.push('item');
      return Promise.resolve();
    },
    findTypes: (): Promise<{ rows: unknown[]; total: number }> =>
      Promise.resolve({ rows: [], total: 0 }),
    findItems: (): Promise<{ rows: unknown[]; total: number }> =>
      Promise.resolve({ rows: [], total: 0 }),
  } as unknown as DictRepository;
  return { service: new DictService(repository), calls, softDeletes };
}

describe('DictService', () => {
  it('1. deleteType 底下还有项 → 25103，且**不**软删', async () => {
    // 判序是这条的判据：先删再判会出现「删不掉」和「已经删了」同时成立。
    const { service, softDeletes } = build({ countItemsByTypeId: 3 });

    await expect(service.deleteType(1n)).rejects.toMatchObject({
      response: { code: ErrorCode.DICT_TYPE_HAS_ITEMS },
      status: HttpStatus.CONFLICT,
    });
    expect(softDeletes).toEqual([]);
  });

  it('2. deleteType 没有项 → 软删', async () => {
    const { service, softDeletes } = build({ countItemsByTypeId: 0 });

    await expect(service.deleteType(1n)).resolves.toBeUndefined();
    expect(softDeletes).toEqual(['type']);
  });

  it('3. createItem 的字典类型不存在 → 25101，且不查重不写库', async () => {
    const { service, calls } = build({ findTypeById: null });

    await expect(
      service.createItem({ dictTypeId: '1', label: '男', value: 'M' }),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.DICT_TYPE_NOT_FOUND },
    });
    expect(calls).not.toContain('existsItemByTypeAndValue');
  });

  it('4. 同类型下 value 重复 → 25105（重名是按类型限定的，不是全局）', async () => {
    const { service } = build({ existsItemByTypeAndValue: true });

    await expect(
      service.createItem({ dictTypeId: '1', label: '男', value: 'M' }),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.DICT_ITEM_VALUE_TAKEN },
    });
  });

  it('5. updateItem 只改 label 不动 value → 不做重名检查（同值不算重名）', async () => {
    // 反过来（一律查重）会把自己当成自己的重名，任何「只改显示名」都会失败。
    const { service, calls } = build();

    await expect(
      service.updateItem(10n, { label: '男性' }),
    ).resolves.toBeDefined();
    expect(calls).not.toContain('existsItemByTypeAndValue');
  });

  it('6. updateItem 改 value 时按**当前类型**查重（不是全局）', async () => {
    const { service } = build({ existsItemByTypeAndValue: true });

    await expect(
      service.updateItem(10n, { label: '男', value: 'F' }),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.DICT_ITEM_VALUE_TAKEN },
    });
  });

  it('7. updateType 改 code 时才查重；code 不变 → 不查', async () => {
    const unchanged = build();
    await expect(
      unchanged.service.updateType(1n, { name: '性别二' }),
    ).resolves.toBeDefined();
    expect(unchanged.calls).not.toContain('existsTypeByCode');

    const taken = build({ existsTypeByCode: true });
    await expect(
      taken.service.updateType(1n, { name: '性别', code: 'sex' }),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.DICT_TYPE_CODE_TAKEN },
    });
  });

  it('8. NOT NULL 列传 null → 10002 / 400，不落到 Prisma', async () => {
    const { service } = build();

    await expect(
      service.updateItem(10n, { value: null } as unknown as UpdateDictItemDto),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.PARAM_INVALID },
      status: HttpStatus.BAD_REQUEST,
    });
    await expect(
      service.updateType(1n, { code: null } as unknown as UpdateDictTypeDto),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.PARAM_INVALID },
    });
  });

  it('9. createType 编码重复 → 25102', async () => {
    const { service } = build({ existsTypeByCode: true });

    await expect(
      service.createType({ code: 'gender', name: '性别' }),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.DICT_TYPE_CODE_TAKEN },
    });
  });

  it('10. 字典项不存在 → 25104 / 404', async () => {
    const { service } = build({ findItemById: null });

    await expect(service.findItem(9n)).rejects.toMatchObject({
      response: { code: ErrorCode.DICT_ITEM_NOT_FOUND },
      status: HttpStatus.NOT_FOUND,
    });
  });
});
