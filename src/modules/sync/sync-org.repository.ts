import { Injectable } from '@nestjs/common';
import type { SyncOrgUnit } from '@prisma/client';
import { currentActorId } from '../../common/context/request-context';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** `SyncOrgUnit` 的内容列——`code` 是自然键不在此列，`syncedAt` / `syncRunId` 是出处 */
export interface SyncOrgUnitContent {
  name: string;
  kind: string | null;
  syncedAt: Date;
  /** 登录自动建号没有同步流水，允许 null */
  syncRunId: bigint | null;
}

/**
 * `SyncOrgUnit` 的数据访问。**配行只能 find-then-write**（Ruling 18）：
 * `code` 的唯一性在 DB-11 生成列 `code_active` 上，Prisma 表达不出生成列，
 * `WhereUniqueInput` 里只有 `id`——`upsert` / `connectOrCreate` 配不了行。
 */
@Injectable()
export class SyncOrgRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByCode(code: string): Promise<SyncOrgUnit | null> {
    return this.prisma.client.syncOrgUnit.findFirst({ where: { code } });
  }

  async findById(id: bigint): Promise<SyncOrgUnit | null> {
    return this.prisma.client.syncOrgUnit.findFirst({ where: { id } });
  }

  /**
   * 全量跑时列出**未删**的行，用来认「批里没有 = 源系统删了」。
   * 走 `client`（过滤 `deleted_at`）：已经软删的行不能被再判一次删除。
   */
  async listActive(): Promise<SyncOrgUnit[]> {
    return this.prisma.client.syncOrgUnit.findMany({ orderBy: { id: 'asc' } });
  }

  /** 新建一行。`parentId` / `deptId` 由后面的两趟补，这里先留空 */
  async create(
    code: string,
    content: SyncOrgUnitContent,
  ): Promise<SyncOrgUnit> {
    return this.prisma.client.syncOrgUnit.create({
      data: {
        code,
        ...content,
        parentId: null,
        deptId: null,
        // 类型占位：扩展会剥掉再按当前操作者重写（同步任务跑在请求上下文之外，
        // 落库的是 SYSTEM_USER_ID）。列 NOT NULL 且无默认值，不给过不了类型
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
  }

  /** 更新内容列。**`syncedAt` / `syncRunId` 也一起写**——它们记「这一行的内容来自哪一次跑」 */
  async updateContent(id: bigint, content: SyncOrgUnitContent): Promise<void> {
    await this.prisma.client.syncOrgUnit.update({
      where: { id },
      data: content,
    });
  }

  /**
   * 挂上级。**内容全同就不写**：幂等判据要求同一批跑两次表内容不变，
   * 而 `updated_at` 是审计列会被扩展开走，真写了就对不齐。
   *
   * **返回这一行现在的样子**：调用方拿它刷新自己那张 `code → 行` 的表，
   * 否则同一趟里「父刚投影出 `deptId`、子就读它」会读到旧值，
   * 子被误判成 `org_not_found`（这一条是用例逼出来的，不是想出来的）。
   */
  async linkParent(
    row: SyncOrgUnit,
    parentId: bigint | null,
  ): Promise<SyncOrgUnit> {
    if (row.parentId === parentId) return row;
    return this.prisma.client.syncOrgUnit.update({
      where: { id: row.id },
      data: { parentId },
    });
  }

  /** 记下这一行投影出了哪条 `SysDept`。同上，全同不写，返回现值 */
  async linkDept(row: SyncOrgUnit, deptId: bigint): Promise<SyncOrgUnit> {
    if (row.deptId === deptId) return row;
    return this.prisma.client.syncOrgUnit.update({
      where: { id: row.id },
      data: { deptId },
    });
  }

  /**
   * 源系统删行的落法是**软删**（N1），不是 delete：
   * `delete` / `deleteMany` 连同步作用域里也被 R24 拒（`test/sync-write-guard.e2e-spec.ts`
   * 钉住了「离场没有第二条路」）。
   *
   * `deletedBy` 要显式写（照 `DeptRepository.softDelete` 的先例）——扩展只补
   * `updatedAt` / `updatedBy`，不补这一列。同步任务跑在请求上下文之外，
   * `currentActorId()` 取到的是 `SYSTEM_USER_ID`。
   */
  async softDelete(id: bigint): Promise<void> {
    await this.prisma.client.syncOrgUnit.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: currentActorId() },
    });
  }
}
