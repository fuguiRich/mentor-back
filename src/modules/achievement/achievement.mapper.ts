import type { Achievement } from '@prisma/client';
import type { AchievementResponseDto } from './dto/achievement-response.dto';

/** 实体 → 响应 DTO（RES-04：显式映射） */
export function toAchievementResponse(
  row: Achievement,
): AchievementResponseDto {
  return {
    id: row.id.toString(),
    mentorProfileId: row.mentorId.toString(),
    type: row.type,
    title: row.title,
    level: row.level,
    awardedAt: toDateOnly(row.awardedAt),
    description: row.description,
    proofFileId: row.proofFileId === null ? null : row.proofFileId.toString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * `DATE` 列 → `YYYY-MM-DD`。
 *
 * Prisma 把 `DATE` 读成 **UTC 零点**的 `Date`。直接 `toISOString()` 会带上
 * `T00:00:00.000Z`，前端在东八区按本地时区格式化就变成前一天。
 * 日期类字段只输出日期部分，不做任何时区换算。
 */
export function toDateOnly(value: Date): string {
  const year = value.getUTCFullYear();
  const month = `${value.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${value.getUTCDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * `awardedAt` 的入参 → 落库值。
 *
 * 只取前 10 位（`YYYY-MM-DD`）再按 **UTC 零点**构造：`DATE` 列不带时区，
 * 传 `2026-09-15T23:00:00+08:00` 会被 MySQL 按日期截断成 `2026-09-15`，
 * 与「先转 UTC 再取日期」得到的 `2026-09-15` 恰好一致——但那是巧合，
 * 换成西半球时区就会差一天。这里显式按字面日期取。
 */
export function toDateColumn(value: string): Date {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}
