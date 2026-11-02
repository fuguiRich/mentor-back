import { Injectable } from '@nestjs/common';
import type { MentorProfile, MentorTimeSlot, SyncPerson } from '@prisma/client';
import { currentActorId } from '../../common/context/request-context';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** 时段的可写列（创建 / 更新共用）。`id` / `mentorProfileId` 不来自请求 */
export interface SlotWrite {
  weekday: number;
  startTime: string;
  endTime: string;
  status: number;
}

/**
 * 导师可指导时段的数据访问（Task 21）。
 *
 * `SyncPerson` / `MentorProfile` 的**读**在这里做是刻意的（同
 * mentor-material.repository 的理由）：身份链（username ↔ login）是本模块判
 * 「这条时段是不是本人」的脊梁，而 SyncModule 不导出它的 repository。
 * **写**仍被 `SYNC_WRITE_FORBIDDEN = 30101` 拒掉——本文件对同步表只有 findFirst。
 *
 * 读一律 `findFirst`（ESLint 禁 `findUnique`：软删除表塞不进 deletedAt 过滤）。
 * `MentorTimeSlot` 在 `SOFT_DELETE_MODELS` 里，`client` 的读天然滤掉已软删行
 * ——「软删后列表不再出现 / 不参与重叠判断 / 同一时段可重建」都由此成立。
 */
@Injectable()
export class MentorSlotRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 身份链第 2 步：SysUser.username → SyncPerson（自然键 login，精确匹配） */
  async findPersonByLogin(login: string): Promise<SyncPerson | null> {
    return this.prisma.client.syncPerson.findFirst({ where: { login } });
  }

  /** 身份链第 3 步：SyncPerson.id → MentorProfile（一人一行，无档案即 null） */
  async findProfileByPersonId(personId: bigint): Promise<MentorProfile | null> {
    return this.prisma.client.mentorProfile.findFirst({ where: { personId } });
  }

  /** 本导师的全部未删时段（weekday 升序，同日按开始时间升序） */
  async findManyByProfile(mentorProfileId: bigint): Promise<MentorTimeSlot[]> {
    return this.prisma.client.mentorTimeSlot.findMany({
      where: { mentorProfileId },
      orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
    });
  }

  /**
   * 按 `{ id, mentorProfileId }` 取一条未删时段。
   *
   * 归属不符（别人的时段）与不存在**同判 null**：调用方一律 404 / 31201，
   * 藏住「这条时段确实存在」——与预约处理要区分「没权限 / 不存在」（403 / 404）
   * 刻意相反（Task 21 计划）。
   */
  async findOwnedById(
    id: bigint,
    mentorProfileId: bigint,
  ): Promise<MentorTimeSlot | null> {
    return this.prisma.client.mentorTimeSlot.findFirst({
      where: { id, mentorProfileId },
    });
  }

  /**
   * 同一导师、同一 weekday 上，与 `[startTime, endTime)` **相交**的未删时段。
   *
   * 相交判据（半开区间）：`已有.startTime < 新.endTime` 且
   * `已有.endTime > 新.startTime`。首尾相接（新 11:00-12:00 紧邻已有
   * 09:00-11:00）不满足两条中的任一条，因此不算冲突。
   *
   * `excludeId` 用于更新：排除自己那一行，否则改自己的时段会与自己相交。
   * `HH:mm` 定长字符串的字典序即时间序，Prisma 的 `lt` / `gt` 直接可用。
   */
  async findOverlapping(
    mentorProfileId: bigint,
    weekday: number,
    startTime: string,
    endTime: string,
    excludeId?: bigint,
  ): Promise<MentorTimeSlot | null> {
    return this.prisma.client.mentorTimeSlot.findFirst({
      where: {
        mentorProfileId,
        weekday,
        startTime: { lt: endTime },
        endTime: { gt: startTime },
        ...(excludeId === undefined ? {} : { id: { not: excludeId } }),
      },
    });
  }

  /** 建一条时段。createdBy / updatedBy 是类型占位，扩展按当前操作者重写（DB-05） */
  async create(
    mentorProfileId: bigint,
    slot: SlotWrite,
  ): Promise<MentorTimeSlot> {
    return this.prisma.client.mentorTimeSlot.create({
      data: {
        mentorProfileId,
        weekday: slot.weekday,
        startTime: slot.startTime,
        endTime: slot.endTime,
        status: slot.status,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
  }

  /** 更新一条时段（只碰业务列；审计列交给扩展） */
  async update(id: bigint, slot: SlotWrite): Promise<MentorTimeSlot> {
    return this.prisma.client.mentorTimeSlot.update({
      where: { id },
      data: {
        weekday: slot.weekday,
        startTime: slot.startTime,
        endTime: slot.endTime,
        status: slot.status,
      },
    });
  }

  /**
   * 删除 = 软删：显式 `update` 打 `deletedAt` / `deletedBy`——扩展拒
   * delete/deleteMany（R24），软删写在 repository 是唯一合法形态。
   */
  async softDelete(id: bigint): Promise<void> {
    await this.prisma.client.mentorTimeSlot.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: currentActorId() },
    });
  }
}
