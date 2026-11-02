import { Injectable } from '@nestjs/common';
import type { Achievement, MentorProfile, SyncPerson } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** 成果的可写列（DTO-12：显式挑字段，`mentorId` 由路径决定，客户端改不到） */
export interface AchievementWrite {
  type: number;
  title: string;
  level: number;
  awardedAt: Date;
  description: string | null;
  proofFileId: bigint | null;
}

/** `PATCH` 的可写列：**没有 `type`**（改了等于换一条成果，见 UpdateAchievementDto） */
export type AchievementPatch = Partial<Omit<AchievementWrite, 'type'>>;

/** 列表筛选（已由 Service 翻译成 where 片段，仓储只负责拼） */
export interface AchievementFilter {
  type?: number;
  level?: number;
  awardedAtFrom?: Date;
  awardedAtTo?: Date;
}

/** 导师档案 + 其人的组织单元（管理员的部门范围判定要用） */
export type ProfileWithDept = MentorProfile & {
  person: SyncPerson & { orgUnit: { deptId: bigint | null } | null };
};

/**
 * 双创成果的数据访问（P3 Task 36）。
 *
 * 只写 `achievement` 一张表；`mentor_profile` / `sync_person` 只读（身份链与
 * 「是不是本人」）。
 *
 * 读一律 `findFirst`（软删表塞不进 `deletedAt` 过滤的 `findUnique`）。
 */
@Injectable()
export class AchievementRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(mentorId: bigint, input: AchievementWrite): Promise<Achievement> {
    return this.prisma.client.achievement.create({
      // createdBy / updatedBy 是类型占位，扩展按当前操作者重写（DB-05）
      data: { mentorId, ...input, createdBy: 0n, updatedBy: 0n },
    });
  }

  /** 按主键取一条**属于该导师且未软删**的成果；不属于 → null（调用方统一 404） */
  findOwnedById(mentorId: bigint, id: bigint): Promise<Achievement | null> {
    return this.prisma.client.achievement.findFirst({
      where: { id, mentorId },
    });
  }

  findPage(
    mentorId: bigint,
    filter: AchievementFilter,
    skip: number,
    take: number,
  ): Promise<[Achievement[], number]> {
    const where = {
      mentorId,
      ...(filter.type === undefined ? {} : { type: filter.type }),
      ...(filter.level === undefined ? {} : { level: filter.level }),
      ...(filter.awardedAtFrom === undefined && filter.awardedAtTo === undefined
        ? {}
        : {
            awardedAt: {
              ...(filter.awardedAtFrom === undefined
                ? {}
                : { gte: filter.awardedAtFrom }),
              ...(filter.awardedAtTo === undefined
                ? {}
                : { lt: filter.awardedAtTo }),
            },
          }),
    };
    return Promise.all([
      this.prisma.client.achievement.findMany({
        where,
        orderBy: [{ awardedAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.client.achievement.count({ where }),
    ]);
  }

  update(id: bigint, patch: AchievementPatch): Promise<Achievement> {
    return this.prisma.client.achievement.update({
      where: { id },
      data: patch,
    });
  }

  /** 软删（扩展把 `deletedAt` / `deletedBy` 按当前操作者写好） */
  async softDelete(id: bigint): Promise<void> {
    await this.prisma.client.achievement.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /** 身份链第 2 步：`SysUser.username` → `SyncPerson.login`（自然键，无外键） */
  findPersonByLogin(login: string): Promise<SyncPerson | null> {
    return this.prisma.client.syncPerson.findFirst({ where: { login } });
  }

  findProfileByPersonId(personId: bigint): Promise<MentorProfile | null> {
    return this.prisma.client.mentorProfile.findFirst({ where: { personId } });
  }

  /** 档案 + 其人的组织单元投影（管理员按部门可见性判定用） */
  findProfileWithDept(id: bigint): Promise<ProfileWithDept | null> {
    return this.prisma.client.mentorProfile.findFirst({
      where: { id },
      include: { person: { include: { orgUnit: true } } },
    });
  }
}
