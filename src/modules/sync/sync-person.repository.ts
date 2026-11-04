import { Injectable } from '@nestjs/common';
import type { SyncPerson } from '@prisma/client';
import { currentActorId } from '../../common/context/request-context';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** `SyncPerson` 的内容列——`login` 是自然键不在此列，`syncedAt` / `syncRunId` 是出处 */
export interface SyncPersonContent {
  realName: string;
  personType: string;
  orgUnitId: bigint;
  major: string | null;
  className: string | null;
  mobile: string | null;
  syncedAt: Date;
  /** 登录自动建号没有同步流水，允许 null */
  syncRunId: bigint | null;
}

/**
 * `SyncPerson` 的数据访问。配行只能 find-then-write（Ruling 18）：
 * `login` 的唯一性在 DB-11 生成列 `login_active` 上，Prisma 表达不出生成列，
 * `WhereUniqueInput` 里只有 `id`。
 */
@Injectable()
export class SyncPersonRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByLogin(login: string): Promise<SyncPerson | null> {
    return this.prisma.client.syncPerson.findFirst({ where: { login } });
  }

  /** 全量跑时列出**未删**的行，用来认「批里没有 = 源系统删了」 */
  async listActive(): Promise<SyncPerson[]> {
    return this.prisma.client.syncPerson.findMany({ orderBy: { id: 'asc' } });
  }

  async create(login: string, content: SyncPersonContent): Promise<SyncPerson> {
    return this.prisma.client.syncPerson.create({
      data: {
        login,
        ...content,
        // 类型占位：扩展会剥掉再按当前操作者重写（同步任务跑在请求上下文之外，
        // 落库的是 SYSTEM_USER_ID）。列 NOT NULL 且无默认值，不给过不了类型
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
  }

  /**
   * 更新内容列。**`syncedAt` / `syncRunId` 也一起写**——它们记「这一行的内容来自
   * 哪一次跑」。调用方先比对过内容，全同时根本不会走到这里（幂等的前提）。
   */
  async updateContent(id: bigint, content: SyncPersonContent): Promise<void> {
    await this.prisma.client.syncPerson.update({
      where: { id },
      data: content,
    });
  }

  /**
   * 源系统删行的落法是**软删**（N1），不是 delete——历史业务数据要能继续关联到人。
   * `deletedBy` 显式写（照 `DeptRepository.softDelete` 的先例），扩展只补
   * `updatedAt` / `updatedBy`。
   */
  async softDelete(id: bigint): Promise<void> {
    await this.prisma.client.syncPerson.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: currentActorId() },
    });
  }
}
