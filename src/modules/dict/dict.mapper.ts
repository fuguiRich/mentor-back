import type { SysDictItem, SysDictType } from '@prisma/client';
import type { DictItemResponseDto } from './dto/dict-item-response.dto';
import type { DictTypeResponseDto } from './dto/dict-type-response.dto';

/** 实体 → Response DTO 的显式映射（规范 RES-04，同 dept.mapper.ts） */
export function toDictTypeResponse(entity: SysDictType): DictTypeResponseDto {
  return {
    id: entity.id.toString(),
    code: entity.code,
    name: entity.name,
    status: entity.status,
    remark: entity.remark,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
    createdBy: entity.createdBy.toString(),
    updatedBy: entity.updatedBy.toString(),
  };
}

export function toDictItemResponse(entity: SysDictItem): DictItemResponseDto {
  return {
    id: entity.id.toString(),
    dictTypeId: entity.dictTypeId.toString(),
    label: entity.label,
    value: entity.value,
    sortOrder: entity.sortOrder,
    status: entity.status,
    remark: entity.remark,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
    createdBy: entity.createdBy.toString(),
    updatedBy: entity.updatedBy.toString(),
  };
}
