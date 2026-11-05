import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  MentorApplication,
  MentorProfile,
  SyncOrgUnit,
  SyncPerson,
} from '@prisma/client';
import type { DataScopeFilter } from '../../common/constants/data-scope';
import {
  PrismaService,
  type PrismaTx,
} from '../../infra/prisma/prisma.service';
import {
  MENTOR_APPLICATION_STATUS,
  MENTOR_APPLICATION_TYPE,
  type MentorProfileDraft,
} from './dto/mentor-application-response.dto';
import {
  MENTOR_PROFILE_STATUS,
  MENTOR_PROFILE_WRITABLE_STATUSES,
} from '../mentor/dto/mentor-profile.dto';

/**
 * 入驻申请落库的载荷——`type` / `status` / `submittedAt` 由服务端定死，不来自入参。
 * `buildSnapshot` 在**事务内**被调用，拿到的是资格门推进后回读的「提交当时的
 * 档案」行——快照的取值时点由这个调用点钉住，不是调用方提前算好传进来。
 */
export interface OnboardSubmissionInput {
  applicantId: bigint;
  profileId: bigint;
  buildSnapshot: (current: MentorProfile) => MentorProfileDraft;
}

/**
 * 申请行 + 申请人 + 申请人部门投影（详情与审核动作要按**申请人部门**判越权）。
 * `orgUnit` 可能为 null（同步软删了组织行）或 `deptId` 为 null（投影未挂上）
 * ——两者都当「没有可见部门」处理（fail-closed，见 service 的可见性判定）。
 */
export type MentorApplicationWithApplicant = MentorApplication & {
  applicant: SyncPerson & { orgUnit: SyncOrgUnit | null };
};

/**
 * R58 的「在审」态集合（task-15-brief §0.4）：`1 SUBMITTED / 2 COLLEGE_REVIEWING /
 * 4 SC_REVIEWING / 5 SC_REJECTED`——管道里还等着人动手。`3 / 6 / 7` 是停留态，
 * 不算在审（退回后能另起一条，判据 12）。`5` 算在审：双创驳回后退回二级学院
 * 重审，二级学院还动得它（R54）。
 */
export const IN_FLIGHT_APPLICATION_STATUSES: readonly number[] = [
  MENTOR_APPLICATION_STATUS.SUBMITTED,
  MENTOR_APPLICATION_STATUS.COLLEGE_REVIEWING,
  MENTOR_APPLICATION_STATUS.SC_REVIEWING,
  MENTOR_APPLICATION_STATUS.SC_REJECTED,
];

/**
 * 信息修改申请的落库载荷（Task 15）——`type=2` / `status` / `submittedAt` 由
 * 服务端定死，不来自入参。`buildSnapshot` 在**事务内**被调用，拿到的是回读的
 * 当前档案行——R67 的「DTO 增量合并到当前 7 字段」就在那个时点做。
 */
export interface ProfileChangeSubmissionInput {
  applicantId: bigint;
  profileId: bigint;
  buildSnapshot: (current: MentorProfile) => MentorProfileDraft;
}

export interface ApplicationListParams {
  status?: number;
  type?: number;
  /** 数据范围。undefined = 不加行级约束（仅供非列表场景） */
  scope?: DataScopeFilter;
  /**
   * `{kind:'self'}` 时的「自己」＝调用者**本人的 personId**（身份链解析）。
   * 申请行的「自己那一份」按申请人（人）译，同 MentorProfile 的口径——
   * 不是 `createdBy = userId`（那是「谁敲的键盘」）。null = 解析不出 → 空集。
   */
  selfPersonId?: bigint | null;
}

/**
 * 列表 where。**抽成纯函数是为了能钉住条件的形状**（同
 * `buildUserListWhere` 的理由）：status / type 与 scope 的部门过滤会落到
 * 同一个 where 的不同键上，混在对象展开里后写的会静默吃掉先写的。
 */
export function buildApplicationListWhere(
  params: ApplicationListParams,
): Prisma.MentorApplicationWhereInput {
  const clauses: Prisma.MentorApplicationWhereInput[] = [
    ...(params.status === undefined ? [] : [{ status: params.status }]),
    ...(params.type === undefined ? [] : [{ type: params.type }]),
    ...applicationScopeClauses(params.scope, params.selfPersonId),
  ];
  return clauses.length === 0 ? {} : { AND: clauses };
}

/**
 * 数据范围 → where 片段：
 * - `depts` → 申请人挂在这些部门下（`applicant.orgUnit.deptId in deptIds`）；
 * - `self` → `applicantId` 等于调用者本人的 personId（解析不出 = 空集）；
 * - `all` → 不加行级约束。空数组 → `in: []` → 一行都不返回（fail-closed）。
 */
function applicationScopeClauses(
  scope: DataScopeFilter | undefined,
  selfPersonId: bigint | null | undefined,
): Prisma.MentorApplicationWhereInput[] {
  if (scope === undefined || scope.kind === 'all') {
    return [];
  }
  if (scope.kind === 'self') {
    return [
      { applicantId: { in: selfPersonId == null ? [] : [selfPersonId] } },
    ];
  }
  return [{ applicant: { orgUnit: { deptId: { in: scope.deptIds } } } }];
}

/**
 * 状态机一跳的落库载荷（Task 14）。
 *
 * `validFrom` 是**合法出发态集合**——服务先预检（错误信息要说清是状态机拒的），
 * repository 的 `updateMany` 再带同一个条件兜并发：两发同时过预检时只有一发
 * 命中（count=1），输家 count=0 → 返回 null → 服务转 409 / 31105（同 R70 的手法）。
 *
 * `profileStatus`：R59/R73 的 `MentorProfile.status` 回写值，**null = 一个字都不写**
 * （`5 SC_REJECTED` 与 `4 SC_REVIEWING` 落点、以及一切 `type=2` 都是 null）。
 * 申请状态与档案状态两笔写在**同一次事务**里（brief §3 末），拆开跑会留死状态。
 */
export interface TransitionInput {
  applicationId: bigint;
  validFrom: readonly number[];
  to: number;
  /** 审核记录落到哪一列；withdraw 不落记录（两个字段都不传） */
  reviewField?: 'collegeReview' | 'scReview';
  record?: Prisma.InputJsonValue;
  profileId: bigint;
  profileStatus: number | null;
  /**
   * type=2 的 `6 APPROVED` 生效落地（Task 15，brief §3 / §4）：只在那一支给。
   * `writeProfile` 在**同一事务内**写 7 个可填报字段（数据源只能是 snapshot，
   * 红线 9）；`recordLogs` 在回读申请行之后、事务提交之前调用，两笔日志经
   * **同一个 `tx`** 落库（R76）——业务回滚则两行日志一起没（红线 16）。
   * 传 `tx` 的 `OpLogService.record` 错误外抛（R77 分岔）：留痕失败整件回滚，
   * 不留「申请已批准但日志缺行」的半截状态。
   */
  landing?: {
    writeProfile: (tx: PrismaTx) => Promise<void>;
    recordLogs: (after: MentorApplication, tx: PrismaTx) => Promise<void>;
  };
  /**
   * 审核通过时**同事务**落一条归档（P4 Task 52 / R66）。
   *
   * 不同事务的话，「审核过了但没归档」会成为一个真实可达的状态——
   * 而 §4.7 要求「审核通过材料**统一**归档」，靠人补是做不到「统一」的。
   * 幂等：同一 `(targetType, targetId)` 已存在未删行时跳过，重复审核不报错。
   */
  /**
   * 审核通过时同事务绑定角色（教师 → 审核通过后叠加 mentor）。
   * 已绑过则跳过；调用方解析不到用户/角色时不传。
   */
  grantRole?: {
    userId: bigint;
    roleId: bigint;
  };
  archive?: {
    targetType: string;
    targetId: string;
    title: string;
    mentorId: bigint | null;
    deptId: bigint | null;
    category: string;
  };
}

/**
 * `MentorApplication` 的数据访问（外加身份链与档案行要用的两条只读）。
 *
 * `SyncPerson` 的**读**在这里做是刻意的（同 mentor.repository.ts 的理由）：
 * 身份链（username ↔ login）是本模块的脊梁，而 SyncModule 不导出它的 repository。
 * **写**仍被扩展的 `SYNC_WRITE_FORBIDDEN = 30101` 拒掉，本文件只有 findFirst。
 *
 * 读一律 `findFirst`（ESLint 禁 `findUnique`：软删除表塞不进 deletedAt 过滤）。
 */
@Injectable()
export class MentorApplicationRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 身份链第 2 步：SysUser.username → SyncPerson（自然键 login，精确匹配） */
  async findPersonByLogin(login: string): Promise<SyncPerson | null> {
    return this.prisma.client.syncPerson.findFirst({ where: { login } });
  }

  /** 身份链第 4 步：本人的 `MentorProfile` 行（一人一行，无行 = 未建档） */
  async findProfileByPersonId(personId: bigint): Promise<MentorProfile | null> {
    return this.prisma.client.mentorProfile.findFirst({ where: { personId } });
  }

  /**
   * 提交入驻申请——**一次事务四步**（brief §2 末：写必须同事务）：
   *
   * 1. R70 原子资格门：`updateMany({ where: { id, status: { in: [0, 3] } },
   *    data: { status: 1 } })` 条件更新——「能不能提交」与 R52「推进到
   *    1 PENDING」合成一步。MySQL 对 UPDATE 是当前读 + 行锁：并发双发只有一发
   *    命中 {0, 3}（count=1），输家等锁后拿到 count=0。
   *    count=0 返回 null（Service 转 409 / 31103，不另起新码）。
   * 2. 事务内回读档案行，`buildSnapshot` 取「提交当时的档案」
   *    （快照取值就在这个时点，此后**永不改写**，brief §3）。
   * 3. 申请行落 `1 SUBMITTED`。
   * 4. 同一事务内走状态机 `1 → 2 COLLEGE_REVIEWING`（`1` 是状态机上的
   *    一条边、不是可停留的状态，对外可见的终态恒为 `2`）。
   *
   * 拆开跑就会留下死状态：档案推到 PENDING 而申请没落库 = 「在审但没有申请」。
   */
  async createOnboardSubmission(
    input: OnboardSubmissionInput,
  ): Promise<MentorApplication | null> {
    return this.prisma.client.$transaction(async (tx) => {
      // R70：资格门 = 条件更新，与状态推进同一条语句（读-改分离会并发出双在审件）
      const gate = await tx.mentorProfile.updateMany({
        where: {
          id: input.profileId,
          status: { in: [...MENTOR_PROFILE_WRITABLE_STATUSES] },
        },
        data: { status: MENTOR_PROFILE_STATUS.PENDING },
      });
      if (gate.count === 0) {
        return null;
      }
      const current = await tx.mentorProfile.findFirst({
        where: { id: input.profileId },
      });
      if (current === null) {
        // 条件更新刚命中同一行，同一事务里读不回来是不可能的——真发生了宁可
        // 抛掉整体回滚，也不能提交「档案已推 1 而申请没落库」的死状态。
        throw new Error('MentorProfile 行在提交事务内消失');
      }
      const created = await tx.mentorApplication.create({
        data: {
          type: MENTOR_APPLICATION_TYPE.ONBOARD,
          applicantId: input.applicantId,
          profileId: input.profileId,
          // Json 列收 Prisma.InputJsonValue；快照是 DTO 键名的普通对象
          snapshot: input.buildSnapshot(
            current,
          ) as unknown as Prisma.InputJsonValue,
          status: MENTOR_APPLICATION_STATUS.SUBMITTED,
          // 可空 Json 列写 SQL NULL（Prisma.DbNull）：JSON null 是「有值的 null」，
          // 读出来一样但列不是空的（sync-run.repository.ts 同款理由）
          collegeReview: Prisma.DbNull,
          scReview: Prisma.DbNull,
          submittedAt: new Date(),
          // createdBy / updatedBy 是类型占位，扩展按当前操作者重写（DB-05）
          createdBy: 0n,
          updatedBy: 0n,
        },
      });
      // 状态机 1 → 2：建行时只落 1，推进是独立的一步（1 不单独暴露）
      return tx.mentorApplication.update({
        where: { id: created.id },
        data: { status: MENTOR_APPLICATION_STATUS.COLLEGE_REVIEWING },
      });
    });
  }

  /** 在审查重（R58）的前置查询：`status ∈ {1, 2, 4, 5}` 有行 = 在审 */
  async hasInFlightApplication(applicantId: bigint): Promise<boolean> {
    const count = await this.prisma.client.mentorApplication.count({
      where: {
        applicantId,
        status: { in: [...IN_FLIGHT_APPLICATION_STATUSES] },
      },
    });
    return count > 0;
  }

  /**
   * 提交信息修改申请——**一次事务两步**（brief §2：只有申请行，**不碰**
   * `MentorProfile`）：
   *
   * 1. **行锁串行化（R58 TOCTOU 收口）**：事务第一句对档案行 `SELECT … FOR
   *    UPDATE`，锁后再做在审查重的 `count`——两个提交事务抢同一把档案行锁，
   *    后到者阻塞到先到者提交后才建一致性读快照，能看到已提交的在审行 →
   *    输家走现成的 `null → 409 / 31106` 分支（不另写分支）。
   * 2. 回读档案行，`buildSnapshot` 产 R67 的合并快照（「改完之后的完整样子」，
   *    不是 DTO 原文）；申请行落 `1 SUBMITTED`，同一事务推进到
   *    `2 COLLEGE_REVIEWING`（1 不单独暴露，同 Task 13 的口径）。
   *
   * **不碰 `MentorProfile`**（§0.5 / 红线 7）：type=2 的提交与一切流转都不写它，
   * 唯一写它的地方是 `6 APPROVED` 的字段回写（applyTransition 的 landing）。
   */
  async createProfileChangeSubmission(
    input: ProfileChangeSubmissionInput,
  ): Promise<MentorApplication | null> {
    return this.prisma.client.$transaction(async (tx) => {
      // R78：这里用裸 SQL 是收 R58 的 TOCTOU 窗口（P1-2）——`FOR UPDATE` 行锁
      // 只有裸 SQL 给得了（`updateMany` 抢锁会动 updatedAt，与「唯一写
      // MentorProfile 的地方是 6 APPROVED 字段回写」自相矛盾；唯一索引要建
      // 迁移，红线 4）。安全面：这是**只读**语句，不写任何行、不碰 Sync 模型，
      // `SYNC_WRITE_FORBIDDEN` 守卫不在它的路上（prisma.extension.ts 的裸 SQL
      // 约定已按 R78 收窄为「写语句才受限」）。边界（R78）：只许
      // `SELECT … FOR UPDATE` 这一种、只许在事务里当第一句。
      await tx.$queryRaw`SELECT id FROM mentor_profile WHERE id = ${input.profileId} FOR UPDATE`;
      const inFlight = await tx.mentorApplication.count({
        where: {
          applicantId: input.applicantId,
          status: { in: [...IN_FLIGHT_APPLICATION_STATUSES] },
        },
      });
      if (inFlight > 0) {
        return null;
      }
      const current = await tx.mentorProfile.findFirst({
        where: { id: input.profileId },
      });
      if (current === null) {
        // 资格门刚确认过行在，同一事务里读不回来是不可能的——真发生了宁可
        // 抛掉整体回滚，也不能提交一份没有档案支撑的提案。
        throw new Error('MentorProfile 行在提交事务内消失');
      }
      const created = await tx.mentorApplication.create({
        data: {
          type: MENTOR_APPLICATION_TYPE.PROFILE_CHANGE,
          applicantId: input.applicantId,
          profileId: input.profileId,
          // Json 列收 Prisma.InputJsonValue；快照是 DTO 键名的普通对象
          snapshot: input.buildSnapshot(
            current,
          ) as unknown as Prisma.InputJsonValue,
          status: MENTOR_APPLICATION_STATUS.SUBMITTED,
          // 可空 Json 列写 SQL NULL（Prisma.DbNull）：JSON null 是「有值的 null」
          // （sync-run.repository.ts 同款理由）
          collegeReview: Prisma.DbNull,
          scReview: Prisma.DbNull,
          submittedAt: new Date(),
          // createdBy / updatedBy 是类型占位，扩展按当前操作者重写（DB-05）
          createdBy: 0n,
          updatedBy: 0n,
        },
      });
      // 状态机 1 → 2：建行时只落 1，推进是独立的一步（1 不单独暴露）
      return tx.mentorApplication.update({
        where: { id: created.id },
        data: { status: MENTOR_APPLICATION_STATUS.COLLEGE_REVIEWING },
      });
    });
  }

  /** 详情 / 审核动作的载入：申请行 + 申请人 + 申请人部门投影（软删行查不出 → 404） */
  async findDetailById(
    id: bigint,
  ): Promise<MentorApplicationWithApplicant | null> {
    return this.prisma.client.mentorApplication.findFirst({
      where: { id },
      include: { applicant: { include: { orgUnit: true } } },
    });
  }

  async findMany(
    params: ApplicationListParams & { page: number; pageSize: number },
  ): Promise<{ rows: MentorApplication[]; total: number }> {
    const where = buildApplicationListWhere(params);

    const [total, rows] = await Promise.all([
      this.prisma.client.mentorApplication.count({ where }),
      this.prisma.client.mentorApplication.findMany({
        where,
        // 新申请在前：审核队列按到达顺序倒着看（用户列表的 id asc 是另一个口径）
        orderBy: [{ id: 'desc' }],
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
    ]);

    return { rows, total };
  }

  /**
   * 状态机一跳——**一次事务两笔写**（申请状态 + `MentorProfile.status`，
   * 后者按 `profileStatus` 的显式取舍写或不写）。
   *
   * `updateMany` 带 `validFrom` 条件更新是并发兜底（见 {@link TransitionInput}）：
   * count=0 返回 null，服务转 409 / 31105——不另起「并发冲突」新码，
   * 对调用方来说「这单被人先动了」与「状态机没这条边」是同一句话。
   */
  async applyTransition(
    input: TransitionInput,
  ): Promise<MentorApplication | null> {
    return this.prisma.client.$transaction(async (tx) => {
      const data: Prisma.MentorApplicationUpdateManyMutationInput = {
        status: input.to,
      };
      if (input.reviewField !== undefined && input.record !== undefined) {
        data[input.reviewField] = input.record;
      }
      const updated = await tx.mentorApplication.updateMany({
        where: {
          id: input.applicationId,
          status: { in: [...input.validFrom] },
        },
        data,
      });
      if (updated.count === 0) {
        return null;
      }

      // R59：这张表只对 type=1 成立（服务算好了写不写；null = 一个字都不写，
      // R73 的 `5 SC_REJECTED` 就在其中）。两笔写必须同事务，拆开跑会留
      // 「档案已回写而申请没动」的死状态。
      if (input.profileStatus !== null) {
        await tx.mentorProfile.updateMany({
          where: { id: input.profileId },
          data: { status: input.profileStatus },
        });
      }

      // Task 15：type=2 的 6 APPROVED 落地——7 个可填报字段写回同一次事务
      // （status 一列不碰，§0.5）。写在状态机之后：申请先落定，回写才有据。
      if (input.landing !== undefined) {
        await input.landing.writeProfile(tx);
      }

      // 审核通过叠加能力角色（teacher → mentor）与状态推进同一事务：
      // 申请已批准但角色没绑上，会让新导师登录后看不到导师功能。
      if (input.grantRole !== undefined) {
        const existingRole = await tx.sysUserRole.findFirst({
          where: input.grantRole,
        });
        if (existingRole === null) {
          await tx.sysUserRole.create({
            data: {
              ...input.grantRole,
              createdBy: 0n,
              updatedBy: 0n,
            },
          });
        }
      }

      const row = await tx.mentorApplication.findFirst({
        where: { id: input.applicationId },
      });
      // 两笔 OpLog 经同一个 tx 落（R76，红线 16）：先 update 再 record，提交前
      // 收口——tx 回滚则申请行 / 档案写回 / 两行日志一起没
      if (row !== null && input.landing !== undefined) {
        await input.landing.recordLogs(row, tx);
      }

      // P4 Task 52：审核通过的归档与状态推进**同一事务**（R66）
      if (input.archive !== undefined) {
        const existing = await tx.archiveItem.findFirst({
          where: {
            targetType: input.archive.targetType,
            targetId: input.archive.targetId,
          },
        });
        if (existing === null) {
          await tx.archiveItem.create({
            data: {
              targetType: input.archive.targetType,
              targetId: input.archive.targetId,
              title: input.archive.title,
              mentorId: input.archive.mentorId,
              deptId: input.archive.deptId,
              category: input.archive.category,
              core: 1,
              archivedAt: new Date(),
              createdBy: 0n,
              updatedBy: 0n,
            },
          });
        }
      }

      return row;
    });
  }
}
