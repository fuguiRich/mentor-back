import type { ArchiveItem } from '@prisma/client';
import { toDateOnlyString } from './archive.time';
import type { ArchiveResponseDto } from './dto/archive-response.dto';

/** JSON 列的兜底读：坏数据不该把列表打成 500 */
function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** 归档行上的附件 ID（JSON 兜底读）；预览 / 下载的归属校验也用它 */
export function archiveFileIds(row: ArchiveItem): string[] {
  return toStringArray(row.fileIds);
}

/** 实体 → 响应 DTO（RES-04：显式映射） */
export function toArchiveResponse(
  row: ArchiveItem,
  files: ReadonlyArray<{
    id: bigint;
    originName: string;
    mimeType: string;
    size: number;
  }> = [],
): ArchiveResponseDto {
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
    fileIds: toStringArray(row.fileIds),
    files: files.map((file) => ({
      id: file.id.toString(),
      originName: file.originName,
      mimeType: file.mimeType,
      size: file.size,
    })),
    createdAt: row.createdAt.toISOString(),
  };
}
