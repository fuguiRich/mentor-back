import { Injectable } from '@nestjs/common';
import type {
  MentorProfile,
  Prisma,
  SyncOrgUnit,
  SyncPerson,
} from '@prisma/client';
import {
  PrismaService,
  type PrismaTx,
} from '../../infra/prisma/prisma.service';

/**
 * 草稿的可写列（响应 DTO 的同名 7 个字段）。**没有 status / personId / mentorType**
 * ——它们不是草稿内容（红线）。
 *
 * 键名与 DTO 一致（`achievements` = 研究成果）；Prisma 模型上那一列叫
 * `researchAchievements`（`achievements` 这个名字被 P3 的成果关系占了），
 * 翻译在本文件里做一处，调用方不感知。
 *
 * `undefined` = 不动该列（增量语义）；`null` = 清空；数组 = 整体替换。
 */
export interface MentorProfileDraftWrite {
  researchFields?: string[];
  summary?: string | null;
  achievements?: string | null;
  guidanceExperience?: string | null;
  affiliateOrg?: string | null;
  socialRoles?: string | null;
  /** 职称 / 资质（R28）。**内校也填**——不做 R49 置空 */
  professionalTitle?: string | null;
}

/**
 * 档案归属人 + 它的组织投影（`SyncOrgUnit.deptId`）。
 * 后台改档要按「档案归属人挂在哪」判数据范围，部门维度只能从这条关系上取。
 */
export type MentorPersonWithOrgUnit = SyncPerson & {
  orgUnit: SyncOrgUnit | null;
};

/**
 * 后台改档的一次事务输入（Task 18）。读旧行、合并、写回、留痕**在同一个
 * `$transaction` 里**——`buildDraft` 拿到的 `before` 就是留痕的 `before`，
 * 判据 3 的「对拍」不会拍到中间态；`recordLog` 传同一个 `tx`，留痕失败
 * 整件回滚（R77）。
 */
export interface AdminUpdateProfileInput {
  id: bigint;
  /** 事务内读旧行之后调用：把入参合并到旧值上，返回要写的**完整**草稿 */
  buildDraft: (
    before: MentorProfile,
    tx: PrismaTx,
  ) => Promise<MentorProfileDraftWrite>;
  /** 写回之后、提交之前落留痕；抛错 = 整件回滚 */
  recordLog: (
    before: MentorProfile,
    after: MentorProfile,
    tx: PrismaTx,
  ) => Promise<void>;
}

/** 草稿列 → Prisma 字段表。undefined 原样带过去：Prisma 对 update 是「跳过」，对 create 是「落默认」 */
function toPrismaDraft(
  draft: MentorProfileDraftWrite,
): Prisma.MentorProfileUpdateInput {
  return {
    researchFields: draft.researchFields,
    summary: draft.summary,
    researchAchievements: draft.achievements,
    guidanceExperience: draft.guidanceExperience,
    affiliateOrg: draft.affiliateOrg,
    socialRoles: draft.socialRoles,
    professionalTitle: draft.professionalTitle,
  };
}

/**
 * `MentorProfile` 的数据访问（外加身份链要用的一条 SyncPerson 只读）。
 *
 * `SyncPerson` 的**读**在这里做是刻意的：身份链（username ↔ login）是本模块的
 * 脊梁，而 SyncModule 只导出 SyncService（同步任务），不导出它的 repository
 * （`src/modules/sync/**` 本任务不动）。**写**是另一回事——扩展的
 * `SYNC_WRITE_FORBIDDEN = 30101` 会拒掉一切业务写入，本文件只有 findFirst。
 *
 * 一人一行靠 DB 的 `uk_mentor_profile_person_id_active`（DB-11 生成列）兜底，
 * Prisma 的 WhereUniqueInput 里没有 personId（生成列表达不出来），所以配行
 * 只能 find-then-write（与 Ruling 18 同因）。
 */
@Injectable()
export class MentorRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 身份链第 2 步：SysUser.username → SyncPerson（自然键 login，精确匹配） */
  async findPersonByLogin(login: string): Promise<SyncPerson | null> {
    return this.prisma.client.syncPerson.findFirst({ where: { login } });
  }

  /**
   * 按人员 id 取归属人（带组织投影，Task 18 的 R49 / 数据范围要用）。
   * `client` 同 `updateDraft`：事务内读写同一个句柄。
   */
  async findPersonById(
    personId: bigint,
    client?: PrismaTx,
  ): Promise<MentorPersonWithOrgUnit | null> {
    return client === undefined
      ? this.prisma.client.syncPerson.findFirst({
          where: { id: personId },
          include: { orgUnit: true },
        })
      : client.syncPerson.findFirst({
          where: { id: personId },
          include: { orgUnit: true },
        });
  }

  async findByPersonId(personId: bigint): Promise<MentorProfile | null> {
    return this.prisma.client.mentorProfile.findFirst({ where: { personId } });
  }

  /**
   * 按行 id 取档案（Task 15 的生效写回要在事务内读旧值留痕）。
   * `client` 同 `updateDraft`：事务内读写同一个句柄。
   */
  async findProfileById(
    id: bigint,
    client?: PrismaTx,
  ): Promise<MentorProfile | null> {
    return client === undefined
      ? this.prisma.client.mentorProfile.findFirst({ where: { id } })
      : client.mentorProfile.findFirst({ where: { id } });
  }

  /**
   * 建草稿行。`status` 恒 0 DRAFT——建行不受 R55 status 门约束（没有行就没有
   * status，建出来的恒 0）。审计四列不手写（扩展按当前操作者自动填），
   * `createdBy` / `updatedBy` 的 0n 是类型占位（列 NOT NULL 且无默认值）。
   */
  async create(
    personId: bigint,
    draft: MentorProfileDraftWrite,
  ): Promise<MentorProfile> {
    return this.prisma.client.mentorProfile.create({
      data: {
        personId,
        status: 0,
        researchFields: draft.researchFields ?? [],
        summary: draft.summary ?? null,
        researchAchievements: draft.achievements ?? null,
        guidanceExperience: draft.guidanceExperience ?? null,
        affiliateOrg: draft.affiliateOrg ?? null,
        socialRoles: draft.socialRoles ?? null,
        professionalTitle: draft.professionalTitle ?? null,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
  }

  /**
   * 更新草稿列。**只碰传进来的列**（undefined 被 Prisma 跳过）——
   * `status` 一列都不碰（审核流的写口在 Task 13 / 14）。
   *
   * `client` 可传事务句柄（Task 15 的生效写回要与申请状态、两笔 OpLog
   * 同一次事务）；不传走根客户端。键名翻译仍在本文件（R68）。
   */
  async updateDraft(
    id: bigint,
    draft: MentorProfileDraftWrite,
    client?: PrismaTx,
  ): Promise<MentorProfile> {
    const data = toPrismaDraft(draft);
    return client === undefined
      ? this.prisma.client.mentorProfile.update({ where: { id }, data })
      : client.mentorProfile.update({ where: { id }, data });
  }

  /** 只改联系电话；`null` = 清除覆盖，回退到同步源手机号 */
  async updateContact(
    id: bigint,
    contactMobile: string | null,
  ): Promise<MentorProfile> {
    return this.prisma.client.mentorProfile.update({
      where: { id },
      data: { contactMobile },
    });
  }

  /**
   * 后台改档（Task 18）——**一次事务四步**，拆开就出事：
   *
   * 1. 事务内读旧行（`before` 就是留痕的旧值，判据 3 的时点由事务钉住）；
   * 2. `buildDraft` 把入参合并到旧值上，得到**完整**的 7 字段新值；
   * 3. `updateDraft` 写回（只碰这 7 列，`status` / `personId` 一列不碰）；
   * 4. `recordLog` 经**同一个 `tx`** 落留痕——它抛错就整件回滚（R77）。
   *
   * 旧行不存在（含已软删）返回 `null`，由 Service 转 404 / 31102；
   * 此时事务里什么都没写。
   */
  async adminUpdateProfile(
    input: AdminUpdateProfileInput,
  ): Promise<MentorProfile | null> {
    return this.prisma.client.$transaction(async (tx) => {
      const before = await this.findProfileById(input.id, tx);
      if (before === null) {
        return null;
      }
      const draft = await input.buildDraft(before, tx);
      const after = await this.updateDraft(input.id, draft, tx);
      await input.recordLog(before, after, tx);
      return after;
    });
  }
}
