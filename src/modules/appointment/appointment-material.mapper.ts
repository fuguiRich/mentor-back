import type {
  AppointmentMaterial,
  GuidanceMaterial,
  SysFile,
} from '@prisma/client';
import {
  MATERIAL_SOURCE,
  type AppointmentMaterialResponseDto,
} from './dto/appointment-material.dto';

/**
 * 预约材料 / 过程材料实体 → Response DTO 的显式映射（规范 RES-04）。
 *
 * BIGINT 一律对外**字符串**（直接 JSON 化会抛）；时间一律 ISO 8601 字符串
 * （RES-07）。`kind`：预约材料回真实值（1 项目计划书 / 2 竞赛备赛资料 /
 * 3 其他，R39 已加列）；过程材料恒 null（`GuidanceMaterial` 无分类列）。
 *
 * 文件名 / 大小 / MIME 从 `SysFile` 行取：文件行缺失（被清）时兜底空值，
 * 不把列表打成 500，也不造假文件名。
 */
export function toAppointmentMaterialResponse(
  entity: AppointmentMaterial,
  file: SysFile | null,
): AppointmentMaterialResponseDto {
  return {
    id: entity.id.toString(),
    source: MATERIAL_SOURCE.APPOINTMENT,
    fileId: entity.fileId.toString(),
    kind: entity.kind,
    originName: file?.originName ?? '',
    mimeType: file?.mimeType ?? '',
    size: file?.size ?? 0,
    createdAt: entity.createdAt.toISOString(),
  };
}

/** 过程材料（`GuidanceMaterial`）→ Response DTO。`source` 固定 `'record'` */
export function toGuidanceMaterialResponse(
  entity: GuidanceMaterial,
  file: SysFile | null,
): AppointmentMaterialResponseDto {
  return {
    id: entity.id.toString(),
    source: MATERIAL_SOURCE.RECORD,
    fileId: entity.fileId.toString(),
    kind: null,
    originName: file?.originName ?? '',
    mimeType: file?.mimeType ?? '',
    size: file?.size ?? 0,
    createdAt: entity.createdAt.toISOString(),
  };
}
