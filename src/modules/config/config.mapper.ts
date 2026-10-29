import type { SysConfig } from '@prisma/client';
import type { ConfigResponseDto } from './dto/config-response.dto';

/** 实体 → Response DTO 的显式映射（规范 RES-04，同 dept.mapper.ts） */
export function toConfigResponse(entity: SysConfig): ConfigResponseDto {
  return {
    id: entity.id.toString(),
    code: entity.code,
    name: entity.name,
    value: entity.value,
    valueType: entity.valueType,
    status: entity.status,
    remark: entity.remark,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
    createdBy: entity.createdBy.toString(),
    updatedBy: entity.updatedBy.toString(),
  };
}
