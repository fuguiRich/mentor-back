import type { SysDept } from '@prisma/client';
import { DeptResponseDto } from './dto/dept-response.dto';
import { DeptTreeResponseDto } from './dto/dept-tree-response.dto';

/**
 * 实体 → Response DTO 的显式映射。
 * 禁止直接返回实体（规范 RES-04）：实体加一个字段，接口就会多返回一个字段，
 * 而没有任何机制提示这是一次接口变更。
 */
export function toDeptResponse(entity: SysDept): DeptResponseDto {
  return {
    id: entity.id.toString(),
    parentId: entity.parentId === null ? null : entity.parentId.toString(),
    name: entity.name,
    sortOrder: entity.sortOrder,
    status: entity.status,
    remark: entity.remark,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
    createdBy: entity.createdBy.toString(),
    updatedBy: entity.updatedBy.toString(),
  };
}

/** 扁平列表按 parentId 组装成树。O(n)，不需要递归查库 */
export function toDeptTree(entities: SysDept[]): DeptTreeResponseDto[] {
  const nodes = new Map<string, DeptTreeResponseDto>();
  for (const entity of entities) {
    nodes.set(entity.id.toString(), {
      ...toDeptResponse(entity),
      children: [],
    });
  }

  const roots: DeptTreeResponseDto[] = [];
  for (const node of nodes.values()) {
    const parent =
      node.parentId === null ? undefined : nodes.get(node.parentId);

    if (parent === undefined) {
      // 父节点为 null，或父节点不在本次结果里（被筛选条件排除）——都当作根节点返回，
      // 否则这些部门会在结果里凭空消失
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }

  return roots;
}
