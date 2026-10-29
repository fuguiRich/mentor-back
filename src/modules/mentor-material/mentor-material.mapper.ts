import type { MentorApplicationMaterial, SysFile } from '@prisma/client';
import type { MaterialKind } from './dto/attach-material.dto';
import type { MaterialResponseDto } from './dto/material-response.dto';

/**
 * 实体 → Response DTO 的显式映射（RES-04）。BIGINT 一律对外字符串。
 * 文件名 / 大小 / MIME 从 `SysFile` 行取：文件行缺失（被清）时兜底空值，
 * 不把列表打成 500，也不造假文件名（RES-07：缺失就是缺失）。
 */
export function toMaterialResponse(
  entity: MentorApplicationMaterial,
  file: SysFile | null,
): MaterialResponseDto {
  return {
    id: entity.id.toString(),
    applicationId: entity.applicationId.toString(),
    fileId: entity.fileId.toString(),
    kind: entity.kind as MaterialKind,
    originName: file?.originName ?? '',
    mimeType: file?.mimeType ?? '',
    size: file?.size ?? 0,
    createdAt: entity.createdAt.toISOString(),
  };
}
