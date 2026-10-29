import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ErrorCode } from '../../common/constants/error-code';
import { currentUser } from '../../common/context/request-context';
import { BusinessException } from '../../common/errors/business.exception';
import type { PrismaTx } from '../../infra/prisma/prisma.service';
import { OpLogRepository } from './oplog.repository';
import { toOpLogResponse } from './oplog.mapper';
import type { OpLogPageResponseDto, QueryOpLogDto } from './dto/oplog.dto';
import type { OpLogResponseDto } from './dto/oplog-response.dto';

/**
 * 写一条操作日志的入参。**调用方只填它知道的事**——
 * 操作人 / 操作人姓名由服务从请求上下文里取，请求侧的 method / path / ip / userAgent
 * 由调用方传进来（上下文里没有它们，硬塞进 RequestContext 会让一个只为鉴权而生的
 * 结构开始记 HTTP 细节）。
 */
export interface OpLogInput {
  module: string;
  action: string;
  targetType?: string;
  targetId?: string;
  method: string;
  path: string;
  ip?: string;
  userAgent?: string;
  /** 1 成功 / 0 失败 */
  status: 0 | 1;
  errorCode?: number;
  errorMsg?: string;
  /** 变更前快照（更新 / 删除时给）；不给就是 null */
  before?: unknown;
  /** 变更后快照（新建 / 更新时给）；不给就是 null */
  after?: unknown;
  durationMs: number;
}

@Injectable()
export class OpLogService {
  private readonly logger = new Logger(OpLogService.name);

  constructor(private readonly repository: OpLogRepository) {}

  async findPage(query: QueryOpLogDto): Promise<OpLogPageResponseDto> {
    const { rows, total } = await this.repository.findMany({
      ...(query.module === undefined ? {} : { module: query.module }),
      ...(query.action === undefined ? {} : { action: query.action }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.operatorId === undefined
        ? {}
        : { createdBy: BigInt(query.operatorId) }),
      ...(query.targetType === undefined
        ? {}
        : { targetType: query.targetType }),
      ...(query.targetId === undefined ? {} : { targetId: query.targetId }),
      ...(query.startTime === undefined ? {} : { startTime: query.startTime }),
      ...(query.endTime === undefined ? {} : { endTime: query.endTime }),
      page: query.page,
      pageSize: query.pageSize,
    });

    return {
      list: rows.map(toOpLogResponse),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async findOne(id: bigint): Promise<OpLogResponseDto> {
    const entity = await this.repository.findById(id);
    if (entity === null) {
      throw new BusinessException(
        ErrorCode.OP_LOG_NOT_FOUND,
        '操作日志不存在',
        HttpStatus.NOT_FOUND,
      );
    }
    return toOpLogResponse(entity);
  }

  /**
   * 记一条操作日志。**分岔在有没有 `tx`（裁定 R77）**：
   *
   * - **没传 `tx`：永不抛**——日志是旁路，写失败不能把已经成功的业务请求打成 500；
   * - **传了 `tx`：错误往外抛，整件一起回滚**——共享事务里「回滚 ⇒ 日志也没了」
   *   （红线 16 要的）与「日志失败 ⇒ 业务照提交」互斥，落地留痕取前者。
   *   这个分岔就在这里，**别把 catch 加回来**（加回来就变回第二条，红线 16 不成立）。
   *
   * 保证放在这里而不是 repository.insert：业务模块调的是这个方法，
   * 策略就该落在调用方能依赖的那一层（见 oplog.repository.ts 的同段注释）。
   *
   * 快照里出现口令 / 令牌这类字段时由调用方负责抹掉再传进来：
   * 这里不做字段黑名单，因为「哪些字段敏感」是业务才知道的事，
   * 一个全局黑名单会在第一个漏网字段上给人虚假的安全感。
   */
  async record(input: OpLogInput, tx?: PrismaTx): Promise<void> {
    const user = currentUser();
    const row = {
      module: input.module,
      action: input.action,
      ...(input.targetType === undefined
        ? {}
        : { targetType: input.targetType }),
      ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
      // 快照的是「当时的名字」，不是外键——改名 / 销号后历史日志不动
      operatorName: (user?.username ?? 'system').slice(0, 50),
      method: input.method,
      path: input.path,
      ...(input.ip === undefined ? {} : { ip: input.ip.slice(0, 45) }),
      ...(input.userAgent === undefined
        ? {}
        : { userAgent: input.userAgent.slice(0, 255) }),
      status: input.status,
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      ...(input.errorMsg === undefined
        ? {}
        : { errorMsg: input.errorMsg.slice(0, 500) }),
      ...(isSnapshot(input.before)
        ? { before: input.before as Prisma.InputJsonValue }
        : {}),
      ...(isSnapshot(input.after)
        ? { after: input.after as Prisma.InputJsonValue }
        : {}),
      durationMs: input.durationMs,
    };

    // R77：入参整形恒在 service（上面），分岔只包落库这一下
    if (tx !== undefined) {
      await this.repository.insert(row, tx);
      return;
    }
    try {
      await this.repository.insert(row);
    } catch (error) {
      this.logger.error(
        `操作日志写入失败（业务不受影响）module=${input.module} action=${input.action}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

/**
 * Prisma 的 Json 列不接受 `undefined`，只接受 `null` 或具体值；
 * 而 `null` / 非对象的快照没有记录价值，直接不写。
 */
function isSnapshot(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}
