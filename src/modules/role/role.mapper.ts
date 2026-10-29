import type { SysRole } from '@prisma/client';
import { RoleDetailResponseDto } from './dto/role-detail-response.dto';
import { RoleResponseDto } from './dto/role-response.dto';

/** 实体 → Response DTO 的显式映射（规范 RES-04，同 dept.mapper.ts） */
export function toRoleResponse(entity: SysRole): RoleResponseDto {
  return {
    id: entity.id.toString(),
    name: entity.name,
    code: entity.code,
    dataScope: entity.dataScope,
    status: entity.status,
    remark: entity.remark,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
    createdBy: entity.createdBy.toString(),
    updatedBy: entity.updatedBy.toString(),
  };
}

export function toRoleDetailResponse(
  entity: SysRole,
  permissionIds: bigint[],
): RoleDetailResponseDto {
  return {
    ...toRoleResponse(entity),
    permissionIds: permissionIds.map((id) => id.toString()),
  };
}
