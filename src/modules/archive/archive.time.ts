/**
 * 归档保留期的日期运算（P4 Task 52 / Task 53）。
 *
 * `retention_until` 是 `DATE` 列，Prisma 读成 **UTC 零点**的 `Date`。
 * 这里所有函数都在「UTC 零点的日历日」这一表示上运算：
 * - 「今天」先按业务时区（`APP_TIMEZONE`，默认 `Asia/Shanghai`）取日历日；
 * - 加减天数按 UTC 日历日推进（`Date.UTC` 自动处理跨月 / 跨年）。
 *
 * 不按 UTC 取「今天」的原因与 R31 相同：北京时间 00:00–08:00 之间 UTC
 * 还是前一天，清理会比预期晚一天。
 */

/** 业务时区里的「今天」，表示为 `DATE` 列的 UTC 零点 */
export function todayInTimeZone(now: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: 'year' | 'month' | 'day'): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return new Date(Date.UTC(value('year'), value('month') - 1, value('day')));
}

/** 在「UTC 零点的日历日」上推进 `days` 天（可为负） */
export function addDays(date: Date, days: number): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() + days,
    ),
  );
}

/** `DATE` 列 → `YYYY-MM-DD`（只取 UTC 年月日，不做时区换算） */
export function toDateOnlyString(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** `YYYY-MM-DD` → `DATE` 列的 UTC 零点（只取前 10 位） */
export function dateColumnFromString(value: string): Date {
  const [year, month, day] = value
    .slice(0, 10)
    .split('-')
    .map((part) => Number(part));
  return new Date(Date.UTC(year, month - 1, day));
}
