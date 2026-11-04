import { Injectable } from '@nestjs/common';
import { Prisma, type SyncRun } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import {
  SyncRunStatus,
  type SyncRunDetail,
  type SyncRunStatusValue,
} from './sync.constants';

/**
 * 同步流水的读写。**这张表是同步任务自己的流水**，不是外部真相的副本，
 * 所以不在 `SYNC_OWNED_MODELS` 的守卫范围里（见
 * `src/infra/prisma/prisma.extension.ts` 的头注释）——它本来就要被改
 * （`RUNNING` → `OK` / `PARTIAL` / `FAILED`）。
 */
@Injectable()
export class SyncRunRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 开一条 `RUNNING` 的流水。`startedAt` 取**这一刻**，不是 `@default(now())`——
   *  它要跟 `finishedAt` 配对算时长，也供 `findLastOkFinishedAt` 排序 */
  async start(source: string, mode: 'incremental' | 'full'): Promise<SyncRun> {
    return this.prisma.client.syncRun.create({
      data: {
        source,
        mode,
        startedAt: new Date(),
        status: SyncRunStatus.RUNNING,
        // 类型占位：扩展会剥掉再按当前操作者重写（同步任务跑在请求上下文之外，
        // 落库的是 SYSTEM_USER_ID）。列 NOT NULL 且无默认值，不给过不了类型
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
  }

  /** 收流水。**失败明细不许静默吞**（ERR-07）：`detail` 装不下的东西等于没发生过 */
  async finish(
    id: bigint,
    params: {
      status: SyncRunStatusValue;
      total: number;
      okCount: number;
      failCount: number;
      detail: SyncRunDetail | null;
    },
  ): Promise<SyncRun> {
    return this.prisma.client.syncRun.update({
      where: { id },
      data: {
        status: params.status,
        total: params.total,
        okCount: params.okCount,
        failCount: params.failCount,
        finishedAt: new Date(),
        // `Prisma.DbNull` 是 SQL NULL；`Prisma.JsonNull` 存的是 JSON `null`，
        // 读出来是 `null` 但列不是空的，会骗过「有没有失败明细」的判断
        detail:
          params.detail === null
            ? Prisma.DbNull
            : (params.detail as unknown as Prisma.InputJsonValue),
      },
    });
  }

  /**
   * 增量起点：同 source 最近一条**成功**流水的 `finishedAt`。
   *
   * 只认 `status = OK`（Ruling 25）：**水位只在 OK 时推进**。上一次是
   * PARTIAL / FAILED 就不动它，于是失败那一批的行在下一次增量里仍落在窗口内，
   * 会被原样重试——不需要退全量，也不会静默漏行。
   *
   * 推论：全量跑只有两种触发，一条是从来没有过 OK 流水，另一条是调用方显式
   * `{ mode: 'full' }`。而离场只在全量跑里做（Ruling 23），所以「定期全量」
   * 是运维约定，`mode` 就是那个旋钮。
   */
  async findLastOkFinishedAt(source: string): Promise<Date | null> {
    const run = await this.prisma.client.syncRun.findFirst({
      where: { source, status: SyncRunStatus.OK, finishedAt: { not: null } },
      orderBy: { finishedAt: 'desc' },
      select: { finishedAt: true },
    });
    return run?.finishedAt ?? null;
  }

  /**
   * 增量水位：同 source 最近一条 **OK 或 PARTIAL** 流水的 `startedAt`。
   *
   * PARTIAL 也推进，是为了避免「一行永久 `org_not_found`」把每次同步都拖回全量；
   * 失败行由下一次全量重试。用 `startedAt` 而不是 `finishedAt`，因为同步过程中
   * 更新的行可能落在 `startedAt..finishedAt` 之间，调用方还会再减 5 分钟重叠。
   * FAILED 不推进：拉数失败时源数据是未知的。
   */
  async findLastUsableStartedAt(source: string): Promise<Date | null> {
    const run = await this.prisma.client.syncRun.findFirst({
      where: {
        source,
        status: { in: [SyncRunStatus.OK, SyncRunStatus.PARTIAL] },
      },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    });
    return run?.startedAt ?? null;
  }

  /** 最近一次成功的全量跑；调度器用它决定这次跑全量还是增量 */
  async findLastFinishedByMode(
    source: string,
    mode: 'incremental' | 'full',
  ): Promise<Date | null> {
    const run = await this.prisma.client.syncRun.findFirst({
      where: {
        source,
        mode,
        status: SyncRunStatus.OK,
        finishedAt: { not: null },
      },
      orderBy: { finishedAt: 'desc' },
      select: { finishedAt: true },
    });
    return run?.finishedAt ?? null;
  }

  /** 流水列表。`source` 为空 = 全部来源 */
  async findPage(
    source: string | undefined,
    page: number,
    pageSize: number,
  ): Promise<{ rows: SyncRun[]; total: number }> {
    const where = source === undefined ? {} : { source };
    const [total, rows] = await Promise.all([
      this.prisma.client.syncRun.count({ where }),
      this.prisma.client.syncRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { rows, total };
  }
}
