/** 创建类写入：写全部四个审计字段 */
export type WriteKind = 'create' | 'update';

/**
 * created_at / created_by 写入后不可变（规范 DB-06）。
 * 更新语句里出现它们一律剥掉——包括下划线写法，
 * 避免有人绕过 Prisma 的 camelCase 字段名直接写列名。
 */
const IMMUTABLE_FIELDS = [
  'createdAt',
  'created_at',
  'createdBy',
  'created_by',
] as const;

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 给一条写入的 data 注入审计字段。
 *
 * 关键在于**剥掉**调用方传来的创建字段，而不只是"没传就不写"：
 * 只做后者的话，一处 `update({ createdAt: new Date() })` 就能让这条记录
 * 的创建时间变得不可信，而事后无法区分它是被改过还是原本就填错了。
 */
export function auditData(
  data: unknown,
  kind: WriteKind,
  now: Date,
  actor: bigint,
): Record<string, unknown> {
  const result: Record<string, unknown> = isPlainObject(data)
    ? { ...data }
    : {};

  for (const field of IMMUTABLE_FIELDS) {
    delete result[field];
  }

  result.updatedAt = now;
  result.updatedBy = actor;

  if (kind === 'create') {
    result.createdAt = now;
    result.createdBy = actor;
  }

  return result;
}

/**
 * 给 createMany 的 data 注入创建审计字段。
 *
 * 三种分支各有存在理由：`createMany` 的 data 在生成类型里是
 * `SysDeptCreateManyInput | SysDeptCreateManyInput[]`——**单个对象是合法输入**，
 * 不是不可能出现的形状，最常见的来源就是「少写一对方括号」的笔误。
 * 早先的实现把非数组一律折成空数组，于是这种笔误变成「插 0 行、不报错」。
 */
export function auditCreateManyData(
  data: unknown,
  now: Date,
  actor: bigint,
): unknown {
  if (Array.isArray(data)) {
    return data.map((row) => auditData(row, 'create', now, actor));
  }

  if (isPlainObject(data)) {
    // **刻意保持调用方的形状**：传对象就回对象，不包成数组。
    // 引擎若接受单对象，这一行就带上了审计字段；引擎若拒绝，
    // 报的仍是它本来就会报的那个错——两种世界都不安静。
    return auditData(data, 'create', now, actor);
  }

  // undefined / null / 原始值原样放过，让 Prisma 自己的校验大声报错。
  // 不要折成 []（静默插 0 行），也不要包成 [x]——后者会给幽灵行
  // 注入一整套审计字段，可能插进引擎本会拒绝的垃圾数据。
  return data;
}

/**
 * 给查询条件追加「未删除」过滤（规范 DB-09 的默认过滤要求）。
 * 业务查询默认看不到已删除数据；确需查询时必须显式走 includingDeleted。
 */
export function withNotDeleted(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const where = args.where;

  return {
    ...args,
    where: isPlainObject(where)
      ? { ...where, deletedAt: null }
      : { deletedAt: null },
  };
}
