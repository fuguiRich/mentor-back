import type { SysFile } from '@prisma/client';
import type { FileResponseDto } from './dto/file-response.dto';

/** 实体 → Response DTO 的显式映射（规范 RES-04，同 dept.mapper.ts） */
export function toFileResponse(entity: SysFile): FileResponseDto {
  return {
    id: entity.id.toString(),
    originName: entity.originName,
    ext: entity.ext,
    mimeType: entity.mimeType,
    size: entity.size,
    sha256: entity.sha256,
    uploaderId: entity.createdBy.toString(),
    // ownerId 对外字符串（BIGINT 直接 JSON 化会抛）
    ownerType: entity.ownerType,
    ownerId: entity.ownerId === null ? null : entity.ownerId.toString(),
    createdAt: entity.createdAt.toISOString(),
    previewUrl: `/files/${entity.id.toString()}/preview`,
    downloadUrl: `/files/${entity.id.toString()}/download`,
  };
}
