import {
  auditCreateManyData,
  auditData,
  withNotDeleted,
} from './audit-args.util';

const NOW = new Date('2026-10-12T03:00:00.000Z');
const ACTOR = 7n;

describe('auditData', () => {
  it('创建时写入四个审计字段', () => {
    const result = auditData({ name: '总公司' }, 'create', NOW, ACTOR);

    expect(result).toEqual({
      name: '总公司',
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: ACTOR,
      updatedBy: ACTOR,
    });
  });

  it('更新时只写 updated 两个字段，不动 created', () => {
    const result = auditData({ name: '新名字' }, 'update', NOW, ACTOR);

    expect(result).toEqual({
      name: '新名字',
      updatedAt: NOW,
      updatedBy: ACTOR,
    });
    expect(result).not.toHaveProperty('createdAt');
  });

  it('更新时剥掉调用方传入的 createdAt / createdBy（规范 DB-06）', () => {
    const result = auditData(
      { name: 'x', createdAt: new Date('2000-01-01'), createdBy: 999n },
      'update',
      NOW,
      ACTOR,
    );

    expect(result).not.toHaveProperty('createdAt');
    expect(result).not.toHaveProperty('createdBy');
  });

  it('创建时也不接受调用方指定的创建人——创建人只由上下文决定', () => {
    const result = auditData({ createdBy: 999n }, 'create', NOW, ACTOR);

    expect(result.createdBy).toBe(ACTOR);
  });

  it('下划线写法的审计字段同样被剥掉（防手写 SQL 风格的字段名漏网）', () => {
    const result = auditData(
      { name: 'x', created_at: '2020-01-01', created_by: 1 },
      'update',
      NOW,
      ACTOR,
    );

    expect(result).not.toHaveProperty('created_at');
    expect(result).not.toHaveProperty('created_by');
  });

  it('data 不是对象时退化成只写审计字段，不抛错', () => {
    expect(() => auditData(undefined, 'create', NOW, ACTOR)).not.toThrow();
    expect(auditData(undefined, 'create', NOW, ACTOR)).toEqual({
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: ACTOR,
      updatedBy: ACTOR,
    });
  });
});

describe('auditCreateManyData', () => {
  it('数组：逐行注入创建审计字段，且不改动传入的行', () => {
    const rows = [{ name: 'a' }, { name: 'b' }];

    expect(auditCreateManyData(rows, NOW, ACTOR)).toEqual([
      {
        name: 'a',
        createdAt: NOW,
        updatedAt: NOW,
        createdBy: ACTOR,
        updatedBy: ACTOR,
      },
      {
        name: 'b',
        createdAt: NOW,
        updatedAt: NOW,
        createdBy: ACTOR,
        updatedBy: ACTOR,
      },
    ]);
    expect(rows).toEqual([{ name: 'a' }, { name: 'b' }]);
  });

  it('单个对象：注入审计字段且保持对象形状，不包成数组（data 允许单对象）', () => {
    const result = auditCreateManyData({ name: 'x' }, NOW, ACTOR);

    expect(result).toEqual({
      name: 'x',
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: ACTOR,
      updatedBy: ACTOR,
    });
    expect(Array.isArray(result)).toBe(false);
  });

  it('data 缺失或不是对象时原样放过，交给 Prisma 报错', () => {
    expect(auditCreateManyData(undefined, NOW, ACTOR)).toBeUndefined();
    expect(auditCreateManyData(null, NOW, ACTOR)).toBeNull();
    expect(auditCreateManyData('oops', NOW, ACTOR)).toBe('oops');
  });
});

describe('withNotDeleted', () => {
  it('在没有 where 时补上 deletedAt: null', () => {
    expect(withNotDeleted({})).toEqual({ where: { deletedAt: null } });
  });

  it('保留已有的 where 条件并追加 deletedAt: null', () => {
    const result = withNotDeleted({ where: { status: 1 } });

    expect(result.where).toEqual({ status: 1, deletedAt: null });
  });

  it('调用方 where 里的 deletedAt 会被覆盖为 null（查已删除必须走 includingDeleted）', () => {
    expect(withNotDeleted({ where: { deletedAt: { not: null } } })).toEqual({
      where: { deletedAt: null },
    });
  });

  it('不改动原对象', () => {
    const original = { where: { status: 1 } };
    withNotDeleted(original);

    expect(original).toEqual({ where: { status: 1 } });
  });
});
