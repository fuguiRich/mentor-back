import type { ArchiveItem } from '@prisma/client';
import { toDateOnlyString } from './archive.time';
import type { ArchiveResponseDto } from './dto/archive-response.dto';

/** 实体 → 响应 DTO（RES-04：显式映射） */
export function toArchiveResponse(row: ArchiveItem): ArchiveResponseDto {
  return {
    id: row.id.toString(),
    targetType: row.targetType,
    targetId: row.targetId,
    title: row.title,
    mentorId: row.mentorId === null ? null : row.mentorId.toString(),
    deptId: row.deptId === null ? null : row.deptId.toString(),
    category: row.category,
    core: row.core,
    archivedAt: row.archivedAt.toISOString(),
    retentionUntil:
      row.retentionUntil === null ? null : toDateOnlyString(row.retentionUntil),
    summary: row.summary,
    createdAt: row.createdAt.toISOString(),
  };
}
