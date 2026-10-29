import type { SysPermission } from '@prisma/client';
import type { PermissionType } from './permission.constants';
import { PermissionResponseDto } from './dto/permission-response.dto';
import { PermissionTreeResponseDto } from './dto/permission-tree-response.dto';

/**
 * 实体 → Response DTO 的显式映射（规范 RES-04，同 dept.mapper.ts）。
 *
 * `type` 的断言依据：库里是 VARCHAR 不是枚举（schema.prisma 的刻意选择），
 * 而入口校验（DTO 的 @IsIn）只放行三个值。不在这里再校验一遍——
 * 同一条规则两个真源必然漂移；脏数据进得来的话，该修的是入口。
 */
export function toPermissionResponse(
  entity: SysPermission,
): PermissionResponseDto {
  return {
    id: entity.id.toString(),
    parentId: entity.parentId === null ? null : entity.parentId.toString(),
    type: entity.type as PermissionType,
    code: entity.code,
    name: entity.name,
    path: entity.path,
    component: entity.component,
    icon: entity.icon,
    sortOrder: entity.sortOrder,
    status: entity.status,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
    createdBy: entity.createdBy.toString(),
    updatedBy: entity.updatedBy.toString(),
  };
}

/** 扁平列表按 parentId 组装成树（同 toDeptTree：孤儿提升为根，不消失） */
export function toPermissionTree(
  entities: SysPermission[],
): PermissionTreeResponseDto[] {
  const nodes = new Map<string, PermissionTreeResponseDto>();
  for (const entity of entities) {
    nodes.set(entity.id.toString(), {
      ...toPermissionResponse(entity),
      children: [],
    });
  }

  const roots: PermissionTreeResponseDto[] = [];
  for (const node of nodes.values()) {
    const parent =
      node.parentId === null ? undefined : nodes.get(node.parentId);

    if (parent === undefined) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }

  return roots;
}
