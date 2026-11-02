import { Injectable } from '@nestjs/common';
import type {
  ArchiveItem,
  MentorProfile,
  Prisma,
  SyncPerson,
} from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** 归档的可写列（DTO-12：显式挑字段，`core` 由 Service 按来源决定） */
export interface ArchiveWrite {
  targetType: string;
  targetId: string;
  title: string;
  mentorId: bigint | null;
  deptId: bigint | null;
  category: string;
  core: number;
  archivedAt: Date;
  retentionUntil: Date | null;
  summary: string | null;
}

/** 检索条件（已由 Service 翻译成 where 片段，仓储只负责拼） */
export interface ArchiveFilter {
  mentorId?: bigint;
  deptId?: bigint;
  deptIds?: readonly bigint[];
  category?: string;
  targetType?: string;
  archivedAtFrom?: Date;
  /** 半开上界（`to + 1 天` 的 UTC 零点） */
  archivedAtTo?: Date;
}

/** `PATCH /archives/:id` 的可写列 */
export interface ArchivePatch {
  title?: string;
  summary?: string;
  retentionUntil?: Date | null;
}

/**
 * 归档的数据访问（P4 Task 52）。
 *
 * 写只有 `archive_item` 一张表；两个审核通过点的自动归档在各自的
 * repository / 事务里完成（R66），**不**从这里绕回去。
 *
 * 读一律 `findFirst`（软删表塞不进 `deletedAt` 过滤的 `findUnique`）。
 */
@Injectable()
export class ArchiveRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: ArchiveWrite): Promise<ArchiveItem> {
    return this.prisma.client.archiveItem.create({
      // createdBy / updatedBy 是类型占位，扩展按当前操作者重写（DB-05）
      data: { ...input, createdBy: 0n, updatedBy: 0n },
    });
  }

  /** 同一 `(targetType, targetId)` 的未删行（手工归档 409 判据） */
  findByTarget(
    targetType: string,
    targetId: string,
  ): Promise<ArchiveItem | null> {
    return this.prisma.client.archiveItem.findFirst({
      where: { targetType, targetId },
    });
  }

  findById(id: bigint): Promise<ArchiveItem | null> {
    return this.prisma.client.archiveItem.findFirst({ where: { id } });
  }

  findPage(
    filter: ArchiveFilter,
    skip: number,
    take: number,
  ): Promise<[ArchiveItem[], number]> {
    const where = this.toWhere(filter);
    return Promise.all([
      this.prisma.client.archiveItem.findMany({
        where,
        orderBy: [{ archivedAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.client.archiveItem.count({ where }),
    ]);
  }

  update(id: bigint, patch: ArchivePatch): Promise<ArchiveItem> {
    return this.prisma.client.archiveItem.update({
      where: { id },
      data: patch,
    });
  }

  /** 软删（取消归档）。扩展把 `deletedBy` 按当前操作者写好 */
  async softDelete(id: bigint): Promise<void> {
    await this.prisma.client.archiveItem.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * 过期清理（R65）：**只软删 `archive_item` 行**，绝不碰 `SysFile`。
   *
   * `retentionUntil < today`（严格小于）：`retentionUntil = 今天` 的条目
   * 今天不清理。扩展给 `updateMany` 自动加 `deletedAt: null`，已删行不会
   * 被重复计数——第二次跑 `purged = 0` 由此成立。
   */
  async purgeExpired(today: Date, now: Date): Promise<number> {
    const result = await this.prisma.client.archiveItem.updateMany({
      where: { core: 0, retentionUntil: { lt: today } },
      data: { deletedAt: now },
    });
    return result.count;
  }

  /** 身份链第 2 步：`SysUser.username` → `SyncPerson.login` */
  findPersonByLogin(login: string): Promise<SyncPerson | null> {
    return this.prisma.client.syncPerson.findFirst({ where: { login } });
  }

  findProfileByPersonId(personId: bigint): Promise<MentorProfile | null> {
    return this.prisma.client.mentorProfile.findFirst({ where: { personId } });
  }

  private toWhere(filter: ArchiveFilter): Prisma.ArchiveItemWhereInput {
    const where: Prisma.ArchiveItemWhereInput = {};
    if (filter.mentorId !== undefined) {
      where.mentorId = filter.mentorId;
    }
    if (filter.deptId !== undefined) {
      where.deptId = filter.deptId;
    }
    if (filter.deptIds !== undefined) {
      where.deptId = { in: [...filter.deptIds] };
    }
    if (filter.category !== undefined) {
      where.category = filter.category;
    }
    if (filter.targetType !== undefined) {
      where.targetType = filter.targetType;
    }
    if (
      filter.archivedAtFrom !== undefined ||
      filter.archivedAtTo !== undefined
    ) {
      where.archivedAt = {
        ...(filter.archivedAtFrom === undefined
          ? {}
          : { gte: filter.archivedAtFrom }),
        ...(filter.archivedAtTo === undefined
          ? {}
          : { lt: filter.archivedAtTo }),
      };
    }
    return where;
  }
}
