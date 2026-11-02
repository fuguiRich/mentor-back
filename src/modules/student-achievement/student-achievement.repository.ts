import { Injectable } from '@nestjs/common';
import type {
  MentorProfile,
  Prisma,
  StudentAchievement,
  SyncPerson,
} from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { StudentAchievementWithStudent } from './student-achievement.mapper';

/** 学生成果的可写列（DTO-12：显式挑字段） */
export interface StudentAchievementWrite {
  studentPersonId: bigint;
  deptId: bigint | null;
  type: number;
  title: string;
  level: number;
  awardedAt: Date;
  proofFileId: bigint | null;
}

/** 检索条件（已由 Service 翻译成 where 片段） */
export interface StudentAchievementFilter {
  studentPersonId?: bigint;
  mentorId?: bigint;
  deptIds?: readonly bigint[];
  type?: number;
  linked?: number;
  awardedAtFrom?: Date;
  awardedAtTo?: Date;
}

/** 关联时同事务要落的归档字段 */
export interface LinkArchiveWrite {
  archivedAt: Date;
  retentionUntil: Date;
}

/** 学生 + 其组织单元（部门可见性判定用） */
export type StudentWithDept = SyncPerson & {
  orgUnit: { deptId: bigint | null } | null;
};

/**
 * 学生成果的数据访问（P5 Task 59）。
 *
 * 写 `student_achievement`，并在关联事务里写 `achievement` 与 `archive_item`；
 * 读 `sync_person` / `mentor_profile`。
 */
@Injectable()
export class StudentAchievementRepository {
  constructor(private readonly prisma: PrismaService) {}

  findStudentById(id: bigint): Promise<StudentWithDept | null> {
    return this.prisma.client.syncPerson.findFirst({
      where: { id },
      include: { orgUnit: { select: { deptId: true } } },
    });
  }

  /** 可关联的导师：必须已生效 */
  findApprovedMentorById(id: bigint): Promise<MentorProfile | null> {
    return this.prisma.client.mentorProfile.findFirst({
      where: { id, status: 2 },
    });
  }

  create(input: StudentAchievementWrite): Promise<StudentAchievement> {
    return this.prisma.client.studentAchievement.create({
      data: { ...input, createdBy: 0n, updatedBy: 0n },
    });
  }

  findById(id: bigint): Promise<StudentAchievementWithStudent | null> {
    return this.prisma.client.studentAchievement.findFirst({
      where: { id },
      include: { student: { select: { realName: true } } },
    });
  }

  findPage(
    filter: StudentAchievementFilter,
    skip: number,
    take: number,
  ): Promise<[StudentAchievementWithStudent[], number]> {
    const where = this.toWhere(filter);
    return Promise.all([
      this.prisma.client.studentAchievement.findMany({
        where,
        include: { student: { select: { realName: true } } },
        orderBy: [{ awardedAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.client.studentAchievement.count({ where }),
    ]);
  }

  /**
   * 人工关联（P5-R3）：同一事务里
   * ① 抢占 `mentorId IS NULL` 的行（并发下输家返回 null）→
   * ② 生成导师 `Achievement` → ③ 回填 `achievementId` → ④ 落归档。
   *
   * 已关联的行不会被改写：`updateMany` 的 `mentorId: null` 是并发守卫。
   */
  async link(
    id: bigint,
    mentorId: bigint,
    actorId: bigint,
    archive: LinkArchiveWrite,
  ): Promise<boolean> {
    return this.prisma.client.$transaction(async (tx) => {
      const row = await tx.studentAchievement.findFirst({ where: { id } });
      if (row === null) {
        return false;
      }
      const claimed = await tx.studentAchievement.updateMany({
        where: { id, mentorId: null },
        data: { mentorId, linkedAt: new Date(), linkedBy: actorId },
      });
      if (claimed.count === 0) {
        return false;
      }

      const achievement = await tx.achievement.create({
        data: {
          mentorId,
          type: row.type,
          title: row.title,
          level: row.level,
          awardedAt: row.awardedAt,
          description: '学生双创成果关联',
          proofFileId: row.proofFileId,
          createdBy: 0n,
          updatedBy: 0n,
        },
      });
      await tx.studentAchievement.update({
        where: { id },
        data: { achievementId: achievement.id },
      });

      const targetId = id.toString();
      const existingArchive = await tx.archiveItem.findFirst({
        where: { targetType: 'StudentAchievement', targetId },
      });
      if (existingArchive === null) {
        await tx.archiveItem.create({
          data: {
            targetType: 'StudentAchievement',
            targetId,
            title: row.title,
            mentorId,
            deptId: row.deptId,
            category: 'achievement',
            core: 0,
            archivedAt: archive.archivedAt,
            retentionUntil: archive.retentionUntil,
            createdBy: 0n,
            updatedBy: 0n,
          },
        });
      }
      return true;
    });
  }

  /**
   * 删除学生成果：同事务软删关联的导师 `Achievement` 与归档条目，
   * 再软删学生成果本身。
   */
  async softDeleteWithLinked(id: bigint): Promise<boolean> {
    return this.prisma.client.$transaction(async (tx) => {
      const row = await tx.studentAchievement.findFirst({ where: { id } });
      if (row === null) {
        return false;
      }
      const now = new Date();
      if (row.achievementId !== null) {
        await tx.achievement.update({
          where: { id: row.achievementId },
          data: { deletedAt: now },
        });
      }
      await tx.archiveItem.updateMany({
        where: { targetType: 'StudentAchievement', targetId: id.toString() },
        data: { deletedAt: now },
      });
      await tx.studentAchievement.update({
        where: { id },
        data: { deletedAt: now },
      });
      return true;
    });
  }

  /** 身份链第 2 步：`SysUser.username` → `SyncPerson.login` */
  findPersonByLogin(login: string): Promise<SyncPerson | null> {
    return this.prisma.client.syncPerson.findFirst({ where: { login } });
  }

  findProfileByPersonId(personId: bigint): Promise<MentorProfile | null> {
    return this.prisma.client.mentorProfile.findFirst({ where: { personId } });
  }

  private toWhere(
    filter: StudentAchievementFilter,
  ): Prisma.StudentAchievementWhereInput {
    const where: Prisma.StudentAchievementWhereInput = {};
    if (filter.studentPersonId !== undefined) {
      where.studentPersonId = filter.studentPersonId;
    }
    if (filter.mentorId !== undefined) {
      where.mentorId = filter.mentorId;
    }
    if (filter.deptIds !== undefined) {
      where.deptId = { in: [...filter.deptIds] };
    }
    if (filter.type !== undefined) {
      where.type = filter.type;
    }
    if (filter.linked !== undefined) {
      where.mentorId = filter.linked === 0 ? null : { not: null };
    }
    if (
      filter.awardedAtFrom !== undefined ||
      filter.awardedAtTo !== undefined
    ) {
      where.awardedAt = {
        ...(filter.awardedAtFrom === undefined
          ? {}
          : { gte: filter.awardedAtFrom }),
        ...(filter.awardedAtTo === undefined ? {} : { lt: filter.awardedAtTo }),
      };
    }
    return where;
  }
}
