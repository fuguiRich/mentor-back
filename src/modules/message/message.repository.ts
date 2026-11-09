import { Injectable } from '@nestjs/common';
import type { Message, Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** 消息列表筛选 */
export interface MessageFilter {
  /** 0 未读 / 1 已读；不传为全部 */
  read?: number;
  type?: number;
}

/** 工作进度要看的导师投影 */
export interface VisibleMentor {
  id: bigint;
  login: string;
  realName: string;
  deptId: bigint | null;
}

/** 要落库的一条消息（不含审计列） */
export interface MessageWrite {
  recipientUserId: bigint;
  type: number;
  title: string;
  content: string;
  bizType: string | null;
  bizId: string | null;
}

/** 消息收件人投影（新建消息用） */
export interface MessageRecipient {
  id: bigint;
  realName: string;
  deptId: bigint | null;
}

/**
 * 消息 / 提醒的数据访问（P5 Task 58）。
 *
 * 写只有 `message` 一张表；工作进度对预约 / 考核只读。
 */
@Injectable()
export class MessageRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 范围内生效导师（`deptIds = null` = 全校） */
  async findVisibleMentors(deptIds: bigint[] | null): Promise<VisibleMentor[]> {
    const rows = await this.prisma.client.mentorProfile.findMany({
      where: {
        status: 2,
        ...(deptIds === null
          ? {}
          : { person: { orgUnit: { deptId: { in: deptIds } } } }),
      },
      select: {
        id: true,
        person: {
          select: {
            login: true,
            realName: true,
            orgUnit: { select: { deptId: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      login: row.person.login,
      realName: row.person.realName,
      deptId: row.person.orgUnit?.deptId ?? null,
    }));
  }

  /** `appointment.status = 0` 的条数，按导师分组 */
  async countPendingAppointments(
    mentorIds: readonly bigint[],
  ): Promise<Map<string, number>> {
    if (mentorIds.length === 0) {
      return new Map();
    }
    const rows = await this.prisma.client.appointment.groupBy({
      by: ['mentorProfileId'],
      where: { mentorProfileId: { in: [...mentorIds] }, status: 0 },
      _count: { _all: true },
    });
    return new Map(
      rows.map((row) => [row.mentorProfileId.toString(), row._count._all]),
    );
  }

  /**
   * 逾期未填记录的导师：`status = 1` 且 `requestedTime < now` 且没有指导记录。
   * 返回每人的条数（一条预约最多一条记录，DB-11 唯一键）。
   */
  async countMissingRecords(
    mentorIds: readonly bigint[],
    now: Date,
  ): Promise<Map<string, number>> {
    if (mentorIds.length === 0) {
      return new Map();
    }
    const rows = await this.prisma.client.appointment.findMany({
      where: {
        mentorProfileId: { in: [...mentorIds] },
        status: 1,
        requestedTime: { lt: now },
        guidanceRecords: { none: {} },
      },
      select: { mentorProfileId: true },
    });
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = row.mentorProfileId.toString();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }

  /** 当前学期待处理考核（`status ∈ {0,1}`），按导师分组 */
  async countPendingAssessments(
    mentorIds: readonly bigint[],
    period: string,
  ): Promise<Map<string, number>> {
    if (mentorIds.length === 0) {
      return new Map();
    }
    const rows = await this.prisma.client.assessment.findMany({
      where: {
        mentorId: { in: [...mentorIds] },
        period,
        status: { in: [0, 1] },
      },
      select: { mentorId: true },
    });
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = row.mentorId.toString();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }

  /** 登录名 → 启用的 SysUser（提醒的收件人） */
  async findActiveUsersByLogins(
    logins: readonly string[],
  ): Promise<Map<string, bigint>> {
    if (logins.length === 0) {
      return new Map();
    }
    const rows = await this.prisma.client.sysUser.findMany({
      where: { username: { in: [...logins] }, status: 1 },
      select: { id: true, username: true },
    });
    return new Map(rows.map((row) => [row.username, row.id]));
  }

  findPage(
    recipientUserId: bigint,
    filter: MessageFilter,
    skip: number,
    take: number,
  ): Promise<[Message[], number]> {
    const where = {
      recipientUserId,
      ...(filter.read === undefined
        ? {}
        : filter.read === 0
          ? { readAt: null }
          : { readAt: { not: null } }),
      ...(filter.type === undefined ? {} : { type: filter.type }),
    };
    return Promise.all([
      this.prisma.client.message.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.client.message.count({ where }),
    ]);
  }

  countUnread(recipientUserId: bigint): Promise<number> {
    return this.prisma.client.message.count({
      where: { recipientUserId, readAt: null },
    });
  }

  /** 一条消息落库；`createdBy` / `updatedBy` 由扩展按当前操作者重写 */
  create(input: MessageWrite): Promise<Message> {
    return this.prisma.client.message.create({
      data: { ...input, createdBy: 0n, updatedBy: 0n },
    });
  }

  /** 批量落库；`createdBy` / `updatedBy` 由扩展按当前操作者重写 */
  async createMany(inputs: readonly MessageWrite[]): Promise<number> {
    if (inputs.length === 0) {
      return 0;
    }
    const result = await this.prisma.client.message.createMany({
      data: inputs.map((input) => ({
        ...input,
        createdBy: 0n,
        updatedBy: 0n,
      })),
    });
    return result.count;
  }

  /** 精确收件人：只回启用、未软删的账号 */
  findActiveUsersByIds(ids: readonly bigint[]): Promise<MessageRecipient[]> {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return this.prisma.client.sysUser.findMany({
      where: { id: { in: [...ids] }, status: 1 },
      select: { id: true, realName: true, deptId: true },
    });
  }

  /**
   * 按角色 / 部门选收件人。
   *
   * `deptIds = null` 表示不限部门（`all` 范围）；非 null 时与 `deptId` 取交集。
   */
  findActiveUsersBySelector(input: {
    roleCodes?: readonly string[];
    deptId?: bigint;
    deptIds: bigint[] | null;
  }): Promise<MessageRecipient[]> {
    const where: Prisma.SysUserWhereInput = { status: 1 };
    if (input.deptId !== undefined) {
      where.deptId = input.deptId;
    } else if (input.deptIds !== null) {
      where.deptId = { in: input.deptIds };
    }
    if (input.roleCodes !== undefined && input.roleCodes.length > 0) {
      where.userRoles = {
        some: { role: { code: { in: [...input.roleCodes] } } },
      };
    }
    return this.prisma.client.sysUser.findMany({
      where,
      select: { id: true, realName: true, deptId: true },
      orderBy: { id: 'asc' },
    });
  }

  /** 校验角色 code 是否真实存在（自定义角色也允许） */
  async findExistingRoleCodes(codes: readonly string[]): Promise<Set<string>> {
    if (codes.length === 0) {
      return new Set();
    }
    const rows = await this.prisma.client.sysRole.findMany({
      where: { code: { in: [...codes] }, status: 1 },
      select: { code: true },
    });
    return new Set(rows.map((row) => row.code));
  }

  /** 发送人姓名：`createdBy` → `SysUser.realName`（系统消息不在表里） */
  async findSenderNames(ids: readonly bigint[]): Promise<Map<string, string>> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.prisma.client.sysUser.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, realName: true },
    });
    return new Map(rows.map((row) => [row.id.toString(), row.realName]));
  }

  /**
   * 标记已读。**只认自己的消息**；已读的再标记不刷新 `readAt`（幂等）。
   * 不属于自己 / 不存在 → null（调用方 404 / 38001，藏存在性）。
   */
  async markRead(id: bigint, recipientUserId: bigint): Promise<Message | null> {
    const row = await this.prisma.client.message.findFirst({
      where: { id, recipientUserId },
    });
    if (row === null) {
      return null;
    }
    if (row.readAt !== null) {
      return row;
    }
    return this.prisma.client.message.update({
      where: { id },
      data: { readAt: new Date() },
    });
  }

  /** 当前用户全部未读 → 已读，返回更新条数 */
  async markAllRead(recipientUserId: bigint): Promise<number> {
    const result = await this.prisma.client.message.updateMany({
      where: { recipientUserId, readAt: null },
      data: { readAt: new Date() },
    });
    return result.count;
  }
}
