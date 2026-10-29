import { Injectable } from '@nestjs/common';
import type { Prisma, SysOpLog } from '@prisma/client';
import {
  PrismaService,
  type PrismaTx,
} from '../../infra/prisma/prisma.service';

/**
 * 操作日志仓储。**只有读和插**：表是 append-only，
 * prisma.extension.ts 已经把 update / delete / upsert 直接拒掉（不是靠自觉）。
 */
@Injectable()
export class OpLogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(params: {
    module?: string;
    action?: string;
    status?: number;
    createdBy?: bigint;
    targetType?: string;
    targetId?: string;
    startTime?: Date;
    endTime?: Date;
    page: number;
    pageSize: number;
  }): Promise<{ rows: SysOpLog[]; total: number }> {
    const where: Prisma.SysOpLogWhereInput = {
      ...(params.module === undefined ? {} : { module: params.module }),
      ...(params.action === undefined ? {} : { action: params.action }),
      ...(params.status === undefined ? {} : { status: params.status }),
      ...(params.createdBy === undefined
        ? {}
        : { createdBy: params.createdBy }),
      ...(params.targetType === undefined
        ? {}
        : { targetType: params.targetType }),
      ...(params.targetId === undefined ? {} : { targetId: params.targetId }),
      ...(params.startTime === undefined && params.endTime === undefined
        ? {}
        : {
            createdAt: {
              ...(params.startTime === undefined
                ? {}
                : { gte: params.startTime }),
              ...(params.endTime === undefined ? {} : { lte: params.endTime }),
            },
          }),
    };

    const [total, rows] = await Promise.all([
      this.prisma.client.sysOpLog.count({ where }),
      this.prisma.client.sysOpLog.findMany({
        where,
        // 日志永远是「最新的在最上面」，id 兜底保证同一毫秒内插入顺序稳定
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
    ]);

    return { rows, total };
  }

  async findById(id: bigint): Promise<SysOpLog | null> {
    return this.prisma.client.sysOpLog.findFirst({ where: { id } });
  }

  /**
   * 写一条日志。「失败不能拖垮业务」这条策略在 `OpLogService.record`——
   * 业务模块调的是它，策略就该落在调用方能依赖的那一层，而不是藏在
   * 被它委托的仓储里：换一个仓储就可能把这条保证悄悄弄丢。
   * （R77 的分岔也在那边：传了 `tx` 的调用错误外抛、整件回滚。）
   *
   * 可选 `tx`（裁定 R76）：传了就在那个事务里落（`tx.sysOpLog.create`），
   * 没传走原来的 root client 自动提交。**其余签名一字不动**。
   *
   * `createdBy` / `updatedBy` 是类型层面的必需字段，运行时被扩展按
   * `currentActorId()` 重写（同 dept.repository.ts:30-34）——操作人就是写入人。
   */
  async insert(
    data: {
      module: string;
      action: string;
      targetType?: string;
      targetId?: string;
      operatorName: string;
      method: string;
      path: string;
      ip?: string;
      userAgent?: string;
      status: number;
      errorCode?: number;
      errorMsg?: string;
      before?: Prisma.InputJsonValue;
      after?: Prisma.InputJsonValue;
      durationMs: number;
    },
    tx?: PrismaTx,
  ): Promise<void> {
    const client = tx ?? this.prisma.client;
    await client.sysOpLog.create({
      data: {
        ...data,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
  }
}
