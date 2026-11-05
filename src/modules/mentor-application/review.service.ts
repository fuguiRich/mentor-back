import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { MentorApplication, SysUser } from '@prisma/client';
import type { DataScopeFilter } from '../../common/constants/data-scope';
import {
  MENTOR_APPLICATION_STATUS,
  MENTOR_APPLICATION_TYPE,
} from './dto/mentor-application-response.dto';
import type { MentorProfileDraft } from './dto/mentor-application-response.dto';
import {
  MENTOR_PROFILE_STATUS,
  type MentorProfileResponseDto,
} from '../mentor/dto/mentor-profile.dto';
// 值注入：@Injectable 的 design:paramtypes 要在运行时拿到类本身，
// `import type` 会被抹掉（DI 报「argument at index [0] is undefined」）
import {
  MentorRepository,
  type MentorProfileDraftWrite,
} from '../mentor/mentor.repository';
import { MentorMapperProvider } from '../mentor/mentor-mapper.provider';
import {
  currentDataScopeCeiling,
  type RequestUser,
} from '../../common/context/request-context';
import { ErrorCode } from '../../common/constants/error-code';
import { BusinessException } from '../../common/errors/business.exception';
import { DataScopeService } from '../data-scope/data-scope.service';
import { OpLogService } from '../oplog/oplog.service';
import { UserService } from '../user/user.service';
import type {
  CollegeReviewDto,
  ReviewRecord,
  ScReviewDto,
} from './dto/review.dto';
import {
  normalizeProfileDraft,
  toMentorApplicationResponse,
} from './mentor-application.mapper';
import type {
  MentorApplicationWithApplicant,
  TransitionInput,
} from './mentor-application.repository';
// 值注入：@Injectable 的 design:paramtypes 要在运行时拿到类本身，
// `import type` 会被抹掉（DI 报「argument at index [0] is undefined」）
import { MentorApplicationRepository } from './mentor-application.repository';
import type { MentorApplicationResponseDto } from './dto/mentor-application-response.dto';

const {
  SUBMITTED,
  COLLEGE_REVIEWING,
  COLLEGE_REJECTED,
  SC_REVIEWING,
  SC_REJECTED,
  APPROVED,
  WITHDRAWN,
} = MENTOR_APPLICATION_STATUS;

/** 三个审核动作入口（OpLog 的 action 取值，brief §4） */
export type ReviewAction = 'college-review' | 'sc-review' | 'withdraw';

/** 请求侧的 HTTP 细节（同 file.service 的 RequestMeta，控制器从 `@Req()` 传进来） */
export interface ReviewRequestMeta {
  method: string;
  path: string;
  ip?: string;
  userAgent?: string;
}

/**
 * 状态机登记表（brief §3：10 条合法边 + 4 类显式拒绝 = 14 组）。
 *
 * ```text
 * [1]  1 SUBMITTED         → 2 COLLEGE_REVIEWING   系统自动（Task 13 的提交事务落）
 * [2]  1 SUBMITTED         → 7 WITHDRAWN           withdraw
 * [3]  2 COLLEGE_REVIEWING → 3 COLLEGE_REJECTED    college-review reject
 * [4]  2 COLLEGE_REVIEWING → 4 SC_REVIEWING        college-review approve
 * [5]  2 COLLEGE_REVIEWING → 7 WITHDRAWN           withdraw
 * [6]  3 COLLEGE_REJECTED  → 7 WITHDRAWN           withdraw
 * [7]  4 SC_REVIEWING      → 5 SC_REJECTED         sc-review reject
 * [8]  4 SC_REVIEWING      → 6 APPROVED            sc-review approve
 * [9]  5 SC_REJECTED       → 4 SC_REVIEWING        college-review approve （R54）
 * [10] 5 SC_REJECTED       → 3 COLLEGE_REJECTED    college-review reject  （R54）
 *
 * # 显式拒绝 4 类（不在这张表里，非法一律 409 / 31105）
 * [D1] 4 SC_REVIEWING      → 7 WITHDRAWN           ✗（计划：仅 1/2/3 可撤）
 * [D2] 5 SC_REJECTED       → 7 WITHDRAWN           ✗（同上）
 * [D3] 6 APPROVED          → *                     ✗（终态）
 * [D4] 7 WITHDRAWN         → *                     ✗（终态）
 * ```
 *
 * **`3` 不留出边（除 →7）**：`3 → 4` 不在表上——「退回后重交」走 Task 13 的
 * `POST` 新建一条申请，不是把旧单从 3 推回审核流。它是 [D1]–[D4] 之外的
 * 第 5 类非法流转（判据 8 专门测）。不在这张表里的 (from → to) 一律 31105。
 *
 * [1] 只**登记**：由 Task 13 的提交事务（`createOnboardSubmission`）实现，
 * 本服务不重写、也没有任何动作通向它（三个动作的落点是 7 / 3 / 4 / 6 / 5）。
 */
export interface TransitionEdge {
  /** [1]-[10]，与上面状态机图逐条对应 */
  id: number;
  from: number;
  to: number;
  /** 'system' = 系统自动（登记不实现）；其余 = 三个审核动作之一 */
  via: 'system' | ReviewAction;
}

export const TRANSITION_EDGES: readonly TransitionEdge[] = [
  { id: 1, from: SUBMITTED, to: COLLEGE_REVIEWING, via: 'system' },
  { id: 2, from: SUBMITTED, to: WITHDRAWN, via: 'withdraw' },
  {
    id: 3,
    from: COLLEGE_REVIEWING,
    to: COLLEGE_REJECTED,
    via: 'college-review',
  },
  { id: 4, from: COLLEGE_REVIEWING, to: SC_REVIEWING, via: 'college-review' },
  { id: 5, from: COLLEGE_REVIEWING, to: WITHDRAWN, via: 'withdraw' },
  { id: 6, from: COLLEGE_REJECTED, to: WITHDRAWN, via: 'withdraw' },
  { id: 7, from: SC_REVIEWING, to: SC_REJECTED, via: 'sc-review' },
  { id: 8, from: SC_REVIEWING, to: APPROVED, via: 'sc-review' },
  // [9] / [10]：R54 补的两条出边——5 是停留态，二级学院重审能把它推回 4 或落到 3
  { id: 9, from: SC_REJECTED, to: SC_REVIEWING, via: 'college-review' },
  { id: 10, from: SC_REJECTED, to: COLLEGE_REJECTED, via: 'college-review' },
];

/**
 * 动作 →（决定 → 合法出发态 + 落点）。**实现源**：上面的登记表与这里
 * 由 review.service.spec.ts 双向核对（登记表每条边都得有动作实现、
 * 每个动作组合都得在登记表上），两处漂移立刻红。
 *
 * - `college-review`：approve → 4（[4] 2、[9] 5）；reject → 3（[3] 2、[10] 5）
 * - `sc-review`：approve → 6（[8]）；reject → 5（[7]）
 * - `withdraw`：→ 7（[2] 1、[5] 2、[6] 3）——**仅 1/2/3 可撤**（[D1][D2]）
 */
export const COLLEGE_REVIEW_EDGES = {
  approve: {
    validFrom: [COLLEGE_REVIEWING, SC_REJECTED],
    to: SC_REVIEWING,
  },
  reject: {
    validFrom: [COLLEGE_REVIEWING, SC_REJECTED],
    to: COLLEGE_REJECTED,
  },
} as const;

export const SC_REVIEW_EDGES = {
  approve: { validFrom: [SC_REVIEWING], to: APPROVED },
  reject: { validFrom: [SC_REVIEWING], to: SC_REJECTED },
} as const;

export const WITHDRAW_EDGE = {
  validFrom: [SUBMITTED, COLLEGE_REVIEWING, COLLEGE_REJECTED],
  to: WITHDRAWN,
} as const;

/**
 * 两级审核流（Task 14）——`college-review` / `sc-review` / `withdraw` 三个动作入口。
 *
 * 每个动作的骨架（顺序就是错误码的顺序，别调）：
 *   1. 载入申请行（含申请人 / 申请人部门）——没有 → **404 / 31104**；
 *   2. 数据范围：`resolve`（天花板来自 `@DataScope`）→ 越权判定 →
 *      不可见是 **403 / 10003**（不是 404——要能区分『没权限』和『不存在』）；
 *   3. 状态机预检——没有这条边 → **409 / 31105**；
 *   4. 一次事务两笔写（申请状态 + 按 R59/R73 取舍的 `MentorProfile.status`），
 *      repository 的条件更新兜并发竞态（count=0 同判 31105）；
 *   5. 留痕：进到本服务之后**每个**动作都落 `SysOpLog`（含被 31105 拒的，
 *      status=0）；`PermissionGuard` 挡下的根本进不来、不落。写日志失败是否影响业务
 *      **取决于有没有传 `tx`**：**没传 `tx`** 时 `OpLogService.record` 自己 catch
 *      （不影响业务）；**传了 `tx`**（6 APPROVED 落地那两笔）就让错误外抛、整件回滚
 *      （R77）——别把 catch 加回来。
 */
@Injectable()
export class ReviewService {
  constructor(
    private readonly repository: MentorApplicationRepository,
    private readonly users: UserService,
    private readonly dataScope: DataScopeService,
    private readonly opLog: OpLogService,
    private readonly mentorRepository: MentorRepository,
    private readonly mentorMapper: MentorMapperProvider,
  ) {}

  /** `POST /:id/college-review` —— 二级学院 通过 / 不通过 / 重审（2、5 出发） */
  async collegeReview(
    id: bigint,
    dto: CollegeReviewDto,
    caller: RequestUser,
    meta: ReviewRequestMeta,
  ): Promise<MentorApplicationResponseDto> {
    const started = Date.now();
    let application: MentorApplicationWithApplicant | null = null;
    try {
      application = await this.loadApplication(id);
      const { filter, user } = await this.resolveContext(caller);
      this.assertApplicantVisible(filter, application);

      const edge = COLLEGE_REVIEW_EDGES[dto.decision];
      this.assertTransition(application, edge.validFrom);
      const record = buildReviewRecord(dto, caller, user);

      const row = await this.applyOrRaced({
        application,
        validFrom: edge.validFrom,
        to: edge.to,
        reviewField: 'collegeReview',
        record: record as unknown as Prisma.InputJsonValue,
      });
      await this.recordSuccess(
        'college-review',
        id,
        meta,
        application,
        row,
        started,
      );
      return toMentorApplicationResponse(row);
    } catch (error) {
      await this.recordFailure(
        'college-review',
        id,
        meta,
        error,
        application,
        started,
      );
      throw error;
    }
  }

  /** `POST /:id/sc-review` —— 双创学院 通过 / 不通过（4 出发） */
  async scReview(
    id: bigint,
    dto: ScReviewDto,
    caller: RequestUser,
    meta: ReviewRequestMeta,
  ): Promise<MentorApplicationResponseDto> {
    const started = Date.now();
    let application: MentorApplicationWithApplicant | null = null;
    try {
      application = await this.loadApplication(id);
      const { filter, user } = await this.resolveContext(caller);
      // 天花板 'all'：sc_admin 解析成 {kind:'all'} 恒可见（审全校）。
      // 这道判定让天花板有意义：窄角色（如误授 review-sc 的二级学院账号）
      // 仍然只能动本院的单——不加就等于「谁拿到码谁能审全校」。
      this.assertApplicantVisible(filter, application);

      const edge = SC_REVIEW_EDGES[dto.decision];
      this.assertTransition(application, edge.validFrom);
      const record = buildReviewRecord(dto, caller, user);

      // type=2 的 6 APPROVED：字段写回 + 两笔留痕同事务（brief §3 / §4，红线 16）
      const landing = this.buildApprovedLanding(
        application,
        edge.to,
        meta,
        started,
      );

      const row = await this.applyOrRaced({
        application,
        validFrom: edge.validFrom,
        to: edge.to,
        reviewField: 'scReview',
        record: record as unknown as Prisma.InputJsonValue,
        ...(landing === undefined ? {} : { landing }),
        // P4 Task 52 / R66：终审通过 → 同事务归档
        ...(edge.to === MENTOR_APPLICATION_STATUS.APPROVED
          ? {
              archive: {
                targetType: 'MentorApplication',
                targetId: application.id.toString(),
                title: `导师入驻申请 #${application.id.toString()}`,
                mentorId: application.profileId,
                deptId: application.applicant?.orgUnit?.deptId ?? null,
                category: 'mentor-application',
              },
            }
          : {}),
      });
      if (landing === undefined) {
        // type=2 的 6 APPROVED 两笔留痕已在事务里落（行 1 + 行 2），再走
        // recordSuccess 会把行 1 翻倍
        await this.recordSuccess(
          'sc-review',
          id,
          meta,
          application,
          row,
          started,
        );
      }
      return toMentorApplicationResponse(row);
    } catch (error) {
      await this.recordFailure(
        'sc-review',
        id,
        meta,
        error,
        application,
        started,
      );
      throw error;
    }
  }

  /**
   * `POST /:id/withdraw` —— 申请人撤回（1 / 2 / 3 出发 → 7）。
   *
   * 「只能撤自己的」不靠入参（空 DTO），靠身份链：
   * `caller.userId` → `SysUser.username` → `SyncPerson.login`（自然键）→
   * `personId` 与 `application.applicantId` 比对——解析不出人 / 不是本人，
   * 一律 **403 / 10003**。
   */
  async withdraw(
    id: bigint,
    caller: RequestUser,
    meta: ReviewRequestMeta,
  ): Promise<MentorApplicationResponseDto> {
    const started = Date.now();
    let application: MentorApplicationWithApplicant | null = null;
    try {
      application = await this.loadApplication(id);

      // 红线 15 的运行时绊线（同 submitOnboard）：天花板必须是 'self'。
      // resolve 在 ceiling='self' 时不查库、超管也不豁免。
      const scope = await this.dataScope.resolve(
        {
          userId: caller.userId,
          isSuperAdmin: caller.isSuperAdmin,
          deptId: null,
        },
        currentDataScopeCeiling(),
      );
      if (scope.kind !== 'self' || scope.userId !== caller.userId) {
        throw this.forbidden();
      }

      const user = await this.users.findById(caller.userId);
      const person =
        user === null
          ? null
          : await this.repository.findPersonByLogin(user.username);
      if (person === null || person.id !== application.applicantId) {
        throw this.forbidden();
      }

      this.assertTransition(application, WITHDRAW_EDGE.validFrom);

      const row = await this.applyOrRaced({
        application,
        validFrom: WITHDRAW_EDGE.validFrom,
        to: WITHDRAW_EDGE.to,
      });
      await this.recordSuccess('withdraw', id, meta, application, row, started);
      return toMentorApplicationResponse(row);
    } catch (error) {
      await this.recordFailure(
        'withdraw',
        id,
        meta,
        error,
        application,
        started,
      );
      throw error;
    }
  }

  /** 载入申请行；不存在 / 已软删 → 404 / 31104（错误顺序的第 1 位） */
  private async loadApplication(
    id: bigint,
  ): Promise<MentorApplicationWithApplicant> {
    const application = await this.repository.findDetailById(id);
    if (application === null) {
      throw new BusinessException(
        ErrorCode.MENTOR_APPLICATION_NOT_FOUND,
        '入驻申请不存在',
        HttpStatus.NOT_FOUND,
      );
    }
    return application;
  }

  /**
   * 解析数据范围过滤器 + 取审核人（姓名快照要 `realName`、范围要 `deptId`）。
   * 天花板不传参：`currentDataScopeCeiling()` 从 `@DataScope`（拦截器写进
   * 上下文）取，取不到回落 `'self'`（fail-closed）——两条审核路由分别是
   * `'dept'` / `'all'`（brief §0.3），在 controller 上声明。
   */
  private async resolveContext(
    caller: RequestUser,
  ): Promise<{ filter: DataScopeFilter; user: SysUser | null }> {
    const user = await this.users.findById(caller.userId);
    const filter = await this.dataScope.resolve(
      {
        userId: caller.userId,
        isSuperAdmin: caller.isSuperAdmin,
        deptId: user?.deptId ?? null,
      },
      currentDataScopeCeiling(),
    );
    return { filter, user };
  }

  /**
   * 单条可见性：`assertDeptVisible(filter, 申请人部门)`——申请人部门 =
   * `SyncPerson.orgUnit.deptId`（投影的 `SysDept.id`）。申请人没有部门投影
   * （组织被同步软删 / deptId 为空）时只有 `{kind:'all'}` 看得见（fail-closed）。
   */
  private assertApplicantVisible(
    filter: DataScopeFilter,
    application: MentorApplicationWithApplicant,
  ): void {
    const applicantDeptId = application.applicant.orgUnit?.deptId ?? null;
    if (applicantDeptId === null) {
      if (filter.kind !== 'all') {
        throw this.forbidden();
      }
      return;
    }
    this.dataScope.assertDeptVisible(filter, applicantDeptId);
  }

  /**
   * 状态机预检：出发态不在 `validFrom` 里 → 409 / 31105。
   * 预检只为把错误信息说清楚；真正的把关在 repository 的条件更新（并发兜底）。
   */
  private assertTransition(
    application: MentorApplication,
    validFrom: readonly number[],
  ): void {
    if (!validFrom.includes(application.status)) {
      throw this.transitionInvalid();
    }
  }

  /**
   * 落库一跳：两笔写一次事务（repository 的 `applyTransition`）。
   * `count=0`（并发竞态：另一发刚把这单推走）同判 409 / 31105。
   */
  private async applyOrRaced(input: {
    application: MentorApplicationWithApplicant;
    validFrom: readonly number[];
    to: number;
    reviewField?: 'collegeReview' | 'scReview';
    record?: Prisma.InputJsonValue;
    landing?: TransitionInput['landing'];
    archive?: TransitionInput['archive'];
  }): Promise<MentorApplication> {
    // 入驻申请通过时叠加 mentor 角色；教师角色在同步/建号时已绑。
    const grantRole =
      input.to === APPROVED &&
      input.application.type === MENTOR_APPLICATION_TYPE.ONBOARD
        ? await this.users.resolveRoleGrant(
            input.application.applicant.login,
            'mentor',
          )
        : null;

    const row = await this.repository.applyTransition({
      applicationId: input.application.id,
      validFrom: input.validFrom,
      to: input.to,
      ...(input.reviewField === undefined
        ? {}
        : { reviewField: input.reviewField }),
      ...(input.record === undefined ? {} : { record: input.record }),
      profileId: input.application.profileId,
      profileStatus: this.profileStatusEffect(input.application, input.to),
      ...(input.landing === undefined ? {} : { landing: input.landing }),
      ...(grantRole === null ? {} : { grantRole }),
      ...(input.archive === undefined ? {} : { archive: input.archive }),
    });
    if (row === null) {
      throw this.transitionInvalid();
    }
    if (grantRole !== null) {
      await this.users.clearPermissionCache(grantRole.userId);
    }

    return row;
  }

  /**
   * type=2 的 `6 APPROVED` 生效落地（brief §3 / §4）：只在 `PROFILE_CHANGE`
   * 且落到 `6 APPROVED` 那一支返回；其余分支返回 undefined（不带 landing）。
   *
   * 一次事务三件事（红线 16，实际做法）：申请状态 `4 → 6`（applyTransition
   * 本体）+ 档案 7 个可填报字段写回（`writeProfile`，收 `tx`）+ 两笔 OpLog
   * （`recordLogs`，**经同一个 `tx` 落**，R76）——业务回滚则三样一起没；
   * 传 `tx` 的 `OpLogService.record` 错误外抛（R77），留痕失败整件回滚。
   *
   * - **写回的数据源只能是 `snapshot`**（红线 9）——落库的提案就是当时合并好的
   *   「改完之后的完整样子」（R67），这里不重读当前行、不做二次合并；
   * - `status` / `mentorType` 一列不碰（§0.5 / §3：mentorType 由同步源推导，
   *   本来就不落列）；
   * - 键名翻译在 `MentorRepository.updateDraft`（R68）——本方法一行都不点名
   *   `researchAchievements`；
   * - 留痕两行（§4）：行 1 `targetType='application'`（Task 14 §4 的形状）+
   *   行 2 `targetType='mentorProfile'`（7 字段旧值 / 新值完整快照，不是差集）。
   *   行 1 在这里落、不再走 `recordSuccess`（否则翻倍）。
   */
  private buildApprovedLanding(
    application: MentorApplicationWithApplicant,
    to: number,
    meta: ReviewRequestMeta,
    started: number,
  ): TransitionInput['landing'] {
    if (
      application.type !== MENTOR_APPLICATION_TYPE.PROFILE_CHANGE ||
      to !== APPROVED
    ) {
      return undefined;
    }

    const snapshot = normalizeProfileDraft(application.snapshot);
    const writeback: MentorProfileDraftWrite = {
      researchFields: snapshot.researchFields,
      summary: snapshot.summary,
      achievements: snapshot.achievements,
      guidanceExperience: snapshot.guidanceExperience,
      affiliateOrg: snapshot.affiliateOrg,
      socialRoles: snapshot.socialRoles,
      professionalTitle: snapshot.professionalTitle,
    };
    // 行 2 的「旧值」：写回前在事务里读一次档案行（导师在审期间档案冻结，
    // 但读旧值仍放事务内——留痕的时点由事务钉住）
    let profileBefore: ProfileFieldSnapshot | null = null;

    return {
      writeProfile: async (tx) => {
        const beforeRow = await this.mentorRepository.findProfileById(
          application.profileId,
          tx,
        );
        if (beforeRow !== null) {
          profileBefore = profileFieldSnapshot(
            this.mentorMapper.toMentorProfileResponse(
              beforeRow,
              application.applicant.personType,
            ),
          );
        }
        await this.mentorRepository.updateDraft(
          application.profileId,
          writeback,
          tx,
        );
      },
      recordLogs: async (after, tx) => {
        await this.opLog.record(
          {
            module: 'mentor-application',
            action: 'sc-review',
            targetType: 'application',
            targetId: application.id.toString(),
            method: meta.method,
            path: meta.path,
            ...(meta.ip === undefined ? {} : { ip: meta.ip }),
            ...(meta.userAgent === undefined
              ? {}
              : { userAgent: meta.userAgent }),
            status: 1,
            before: stateSnapshot(application),
            after: stateSnapshot(after),
            durationMs: Date.now() - started,
          },
          tx,
        );
        await this.opLog.record(
          {
            module: 'mentor-application',
            action: 'sc-review',
            targetType: 'mentorProfile',
            targetId: application.profileId.toString(),
            method: meta.method,
            path: meta.path,
            ...(meta.ip === undefined ? {} : { ip: meta.ip }),
            ...(meta.userAgent === undefined
              ? {}
              : { userAgent: meta.userAgent }),
            status: 1,
            ...(profileBefore === null ? {} : { before: profileBefore }),
            after: profileFieldSnapshot(snapshot),
            durationMs: Date.now() - started,
          },
          tx,
        );
      },
    };
  }

  /**
   * 落点 → `MentorProfile.status` 回写（brief §3 副作用表）。
   *
   * **只对 `type === 1 ONBOARD` 成立（裁定 R59）**——显式分支，`type=2` 走空
   * 分支、那一列一个字都不碰：type=2 的申请人已是 `status=2` 的在册导师，
   * 照表回写会把人因一次改字段被拒降级成 REJECTED（数据损坏）。
   *
   * **`5 SC_REJECTED` 不写（裁定 R73）**：那是「退回二级学院重审」，不是
   * 「退回申请人」；写了就把申请人重交的口子打开——两条在审申请、两份分叉的
   * 快照，Task 15 的 R58「一人一件」当场被顶穿。想真拿回档案走 R54 的
   * `5 → 3`（二级学院重审不通过）→ 那一跳才置 `3 REJECTED`。
   *
   * 三个落点碰那一列：`3 → 3 REJECTED`、`6 → 2 APPROVED`、`7 → 0 DRAFT`；
   * `4 SC_REVIEWING`（还在审）也不动。
   */
  private profileStatusEffect(
    application: MentorApplication,
    to: number,
  ): number | null {
    if (application.type !== MENTOR_APPLICATION_TYPE.ONBOARD) {
      return null;
    }
    switch (to) {
      case MENTOR_APPLICATION_STATUS.COLLEGE_REJECTED:
        return MENTOR_PROFILE_STATUS.REJECTED;
      case MENTOR_APPLICATION_STATUS.SC_REJECTED:
        return null;
      case MENTOR_APPLICATION_STATUS.APPROVED:
        return MENTOR_PROFILE_STATUS.APPROVED;
      case MENTOR_APPLICATION_STATUS.WITHDRAWN:
        return MENTOR_PROFILE_STATUS.DRAFT;
      default:
        return null;
    }
  }

  /** 成功留痕：before / after 是**完整快照**（{status, collegeReview, scReview}），不是差集 */
  private async recordSuccess(
    action: ReviewAction,
    id: bigint,
    meta: ReviewRequestMeta,
    before: MentorApplication,
    after: MentorApplication,
    started: number,
  ): Promise<void> {
    await this.opLog.record({
      module: 'mentor-application',
      action,
      targetType: 'application',
      targetId: id.toString(),
      method: meta.method,
      path: meta.path,
      ...(meta.ip === undefined ? {} : { ip: meta.ip }),
      ...(meta.userAgent === undefined ? {} : { userAgent: meta.userAgent }),
      status: 1,
      before: stateSnapshot(before),
      after: stateSnapshot(after),
      durationMs: Date.now() - started,
    });
  }

  /**
   * 失败留痕（进到本服务之后的失败必落，含被 31105 拒的）。
   * `after` 不给——没有发生变更（OpLogInput 的约定：变更后快照只在写入时给）。
   */
  private async recordFailure(
    action: ReviewAction,
    id: bigint,
    meta: ReviewRequestMeta,
    error: unknown,
    application: MentorApplicationWithApplicant | null,
    started: number,
  ): Promise<void> {
    await this.opLog.record({
      module: 'mentor-application',
      action,
      targetType: 'application',
      targetId: id.toString(),
      method: meta.method,
      path: meta.path,
      ...(meta.ip === undefined ? {} : { ip: meta.ip }),
      ...(meta.userAgent === undefined ? {} : { userAgent: meta.userAgent }),
      status: 0,
      errorCode: toErrorCode(error),
      errorMsg: toErrorMessage(error),
      ...(application === null ? {} : { before: stateSnapshot(application) }),
      durationMs: Date.now() - started,
    });
  }

  private transitionInvalid(): BusinessException {
    return new BusinessException(
      ErrorCode.MENTOR_APPLICATION_TRANSITION_INVALID,
      '当前状态不允许该操作',
      HttpStatus.CONFLICT,
    );
  }

  private forbidden(): BusinessException {
    return new BusinessException(
      ErrorCode.FORBIDDEN,
      '无权限',
      HttpStatus.FORBIDDEN,
    );
  }
}

/** 审核记录装配：reviewerId = 调用者 userId（BIGINT 对外字符串），姓名取 realName 快照 */
function buildReviewRecord(
  dto: CollegeReviewDto,
  caller: RequestUser,
  user: SysUser | null,
): ReviewRecord {
  return {
    reviewerId: caller.userId.toString(),
    reviewerName: user?.realName ?? caller.username,
    decision: dto.decision,
    comment: dto.comment,
    at: new Date().toISOString(),
  };
}

/**
 * 留痕的快照形状（brief §4）：`{status, collegeReview, scReview}`——
 * 含状态与两个审核记录，完整记录不是差集（Task 15 的判据按此比对）。
 */
function stateSnapshot(row: MentorApplication): {
  status: number;
  collegeReview: unknown;
  scReview: unknown;
} {
  return {
    status: row.status,
    collegeReview: row.collegeReview,
    scReview: row.scReview,
  };
}

/**
 * 行 2 留痕的快照形状（brief §4）：7 个可填报字段的完整取值（不是差集）。
 * 键名是响应 DTO 的（`achievements`）——R68 的键名翻译只在持久层出现，
 * 留痕里不点名 `researchAchievements`。
 */
type ProfileFieldSnapshot = Required<MentorProfileDraftWrite>;

function profileFieldSnapshot(
  source: MentorProfileResponseDto | MentorProfileDraft,
): ProfileFieldSnapshot {
  return {
    researchFields: source.researchFields,
    summary: source.summary,
    achievements: source.achievements,
    guidanceExperience: source.guidanceExperience,
    affiliateOrg: source.affiliateOrg,
    socialRoles: source.socialRoles,
    professionalTitle: source.professionalTitle,
  };
}

/**
 * 取出业务错误码 / 文案写进操作日志（同 file.service 的同名函数，那里有
 * 为什么不能只看 `error.code` 的说明）。`BusinessException` 的 `{code, message}`
 * 在响应体里，不在错误对象自己身上。
 */
function toErrorCode(error: unknown): number {
  if (!(error instanceof BusinessException)) {
    return ErrorCode.INTERNAL_ERROR;
  }
  const body: unknown = error.getResponse();
  const code =
    typeof body === 'object' && body !== null
      ? (body as { code?: unknown }).code
      : undefined;
  return typeof code === 'number' ? code : ErrorCode.INTERNAL_ERROR;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败';
}
