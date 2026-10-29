import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCode } from '../../common/constants/error-code';
import { BusinessException } from '../../common/errors/business.exception';
import { DeptRepository } from './dept.repository';
import { toDeptResponse, toDeptTree } from './dept.mapper';
import type { DeptResponseDto } from './dto/dept-response.dto';
import type { DeptTreeResponseDto } from './dto/dept-tree-response.dto';

/**
 * 部门模块的对外服务（Task 6b 收口后只读）。
 *
 * `SysDept` 只能由同步投影产生（6a 的 `ProjectionWriter`）：改名、挂树、软删
 * 全在源系统那一侧。create / update / remove 已随之删掉——留着就是给
 * 「手工改组织」开的后门，下次同步一冲就静默丢改动。
 */
@Injectable()
export class DeptService {
  constructor(private readonly repository: DeptRepository) {}

  async findTree(name?: string): Promise<DeptTreeResponseDto[]> {
    const entities = await this.repository.findMany(name);
    const tree = toDeptTree(entities);

    // 判据：从根可达的节点数 < 实体数 ⇒ 数据里有环。
    // toDeptTree 把每个实体恰好放置一次——要么挂在某个根下，要么卷进环里（从任何根都到不了）。
    // 只数根（tree.length）会在「正常根 + 一截游离的环」时放行，环上那截就静默消失；
    // 孤儿提升（parentId 指向不在结果集里的 id）不是丢——它被提升为根，从根可达，不误报。
    if (this.countReachable(tree) < entities.length) {
      throw new BusinessException(
        ErrorCode.INTERNAL_ERROR,
        '部门数据存在环，无法构建部门树',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return tree;
  }

  /** 从 nodes 出发沿 children 走完整棵树，节点总数（返回树里每个节点恰好数一次） */
  private countReachable(nodes: DeptTreeResponseDto[]): number {
    let count = 0;

    for (const node of nodes) {
      count += 1 + this.countReachable(node.children);
    }

    return count;
  }

  async findOne(id: bigint): Promise<DeptResponseDto> {
    const entity = await this.repository.findById(id);
    if (entity === null) {
      this.notFound();
    }

    return toDeptResponse(entity);
  }

  /**
   * 供 user 模块的 `createAccount` 校验 deptId——**只读**，不是第二条写 SysDept 的路。
   *
   * 返回布尔而不是抛 24101：建号入参里的部门 ID 非法是 `PARAM_INVALID = 10001`
   * （计划 §3.3.3 的口径），与部门详情接口的 `DEPT_NOT_FOUND = 24101` 语义不同，
   * 由调用方决定回哪个码。
   */
  async exists(id: bigint): Promise<boolean> {
    const entity = await this.repository.findById(id);
    return entity !== null;
  }

  /** 「部门不存在」只此一处定义：错误码/文案/状态码改动时不会漏掉某个入口 */
  private notFound(): never {
    throw new BusinessException(
      ErrorCode.DEPT_NOT_FOUND,
      '部门不存在',
      HttpStatus.NOT_FOUND,
    );
  }
}
