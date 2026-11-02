import type { Response } from 'express';

/** UTF-8 BOM：Excel / WPS 靠它识别编码，没有就按本地代码页解出乱码（R60） */
export const CSV_BOM = '﻿';

/** CSV 注入的触发字符：以这些开头的字段会被 Excel 当公式执行 */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/**
 * 单个字段的 CSV 转义（RFC 4180 + 注入防护）。
 *
 * - 含 `,` / `"` / `\n` / `\r` → 用双引号包裹，内部 `"` 变 `""`；
 * - 以 `=` `+` `-` `@` 制表符 / 回车开头 → **前置一个单引号**，
 *   让 Excel 把它当文本。不加的话，一条 `=1+1` 的成果名称会变成公式；
 * - `null` / `undefined` → 空串；
 * - `Date` → `YYYY-MM-DD HH:mm:ss`（UTC，与其它时间字段口径一致）。
 */
export function csvEscape(value: unknown): string {
  const text = toCellText(value);
  const guarded = FORMULA_PREFIXES.some((prefix) => text.startsWith(prefix))
    ? `'${text}`
    : text;
  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

/**
 * 任意值 → 单元格文本。
 *
 * 只认 `string` / `number` / `boolean` / `bigint` / `Date`，其余一律空串——
 * 对象直接 `String()` 会得到 `[object Object]`，那比空串更糟：
 * 它看起来像有数据。
 */
export function toCellText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 19).replace('T', ' ');
  }
  if (typeof value === 'string') {
    return value;
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  return '';
}

/** 一行 CSV（不含换行符） */
export function csvLine(values: readonly unknown[]): string {
  return values.map(csvEscape).join(',');
}

/**
 * 开始写一份 CSV：先落 BOM 与表头，再返回逐行写的函数。
 *
 * **调用方必须在此之前完成「行数上限」判定**（R62）：一旦写了 BOM，
 * 响应头就已经发出去，再抛 `EXPORT_TOO_LARGE` 也改不成 409，
 * 客户端只会拿到一份被截断的 CSV。
 */
export function startCsv(
  res: Response,
  filename: string,
  header: readonly string[],
): (rows: readonly (readonly unknown[])[]) => void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  // 文件名一律 ASCII（R61）：非 ASCII 要走 RFC 5987 编码，写错就是头注入面
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.write(CSV_BOM);
  res.write(`${csvLine(header)}\r\n`);
  return (rows) => {
    for (const row of rows) {
      res.write(`${csvLine(row)}\r\n`);
    }
  };
}

/** 导出的文件名：`<resource>-<period|all>-<yyyymmdd>.csv`，**只含 ASCII**（R61） */
export function csvFilename(
  resource: string,
  scope: string,
  now: Date = new Date(),
): string {
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const safeScope = /^[A-Za-z0-9_-]+$/.test(scope) ? scope : 'all';
  return `${resource}-${safeScope}-${date}.csv`;
}
