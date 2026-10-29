import { HttpStatus, Injectable } from '@nestjs/common';
import type { SyncPerson } from '@prisma/client';
import { ErrorCode } from '../../common/constants/error-code';
import type { DataScopeFilter } from '../../common/constants/data-scope';
import {
  currentDataScopeCeiling,
  type RequestUser,
} from '../../common/context/request-context';
import { BusinessException } from '../../common/errors/business.exception';
import { DataScopeService } from '../data-scope/data-scope.service';
import { OpLogService } from '../oplog/oplog.service';
import { UserService } from '../user/user.service';
import {
  MENTOR_PROFILE_STATUS,
  MENTOR_PROFILE_WRITABLE_STATUSES,
  type MentorProfileResponseDto,
  UpdateMentorProfileDto,
} from '../mentor/dto/mentor-profile.dto';
import { MentorMapperProvider } from '../mentor/mentor-mapper.provider';
import { MentorApplicationResponseDto } from './dto/mentor-application-response.dto';
import type { MentorProfileDraft } from './dto/mentor-application-response.dto';
import type {
  MentorApplicationPageResponseDto,
  QueryMentorApplicationDto,
} from './dto/query-application.dto';
import {
  toMentorApplicationResponse,
  toProfileDraft,
} from './mentor-application.mapper';
import type { MentorApplicationWithApplicant } from './mentor-application.repository';
import { MentorApplicationRepository } from './mentor-application.repository';
import type { ReviewRequestMeta } from './review.service';

/**
 * 入驻申请提交（Task 13）——**只做「提交」这一下**；审核归 Task 14，
 * 信息修改申请（type=2）归 Task 15，佐证材料归 Task 16+17。
 *
 * 「我的」申请怎么解析——**这是本模块的脊梁，不写就会长歪**
 * （brief §2 的解析链，同 task-11-brief §4.2，一字不改）：
 *
 *   1. `caller.userId` → `SysUser`（取 `username`）；
 *   2. `SysUser.username` → `SyncPerson` 按 **`login`** 精确匹配（自然键，
 *      **没有外键**）；
 *   3. `SyncPerson.id` = `applicantId`；
 *   4. `MentorProfile` where `personId = 上一步的 id`：无行 → **404 / 31102**，
 *      `personType = 'student'` → **403 / 10003**，`status` 按提交门分流。
 *
 * 「只能提自己的」**不靠入参**（空 DTO，请求体里什么都没有），靠这条链：
 * 解析出来的 applicantId / profileId 只可能是调用者本人的。
 *
 * 数据范围：路由是 `@DataScope('self')`（红线 14）。行级归属由上面这条身份链
 * 实现——`MentorProfile` 的「自己那一份」按 **personId**（人）译，不是
 * `createdBy = userId`（那是「谁敲的键盘」）。`resolve` 的 self 天花板检查是
 * 运行时绊线：有人把 `@DataScope('self')` 改宽时宁可 403 也不开宽口。
 */
@Injectable()
export class MentorApplicationService {
  constructor(
    private readonly repository: MentorApplicationRepository,
    private readonly users: UserService,
    private readonly dataScope: DataScopeService,
    private readonly mentorMapper: MentorMapperProvider,
    private readonly opLog: OpLogService,
  ) {}

  /**
   * GET /mentor-applications —— 分页列表（Task 14，受数据范围约束）。
   *
   * 天花板 `'all'`（brief §0.3）：**不夹窄**，角色的 data_scope 自己收窄
   * （college_admin → 本院及下级，sc_admin → 全校，同 `GET /users` 的套路）。
   * `{kind:'self'}` 的「自己那一份」按**申请人**（personId）译——靠身份链解析，
   * 解析不出（不是导师 / 没配人）就是空集，不是全部。
   */
  async findPage(
    query: QueryMentorApplicationDto,
    caller: RequestUser,
  ): Promise<MentorApplicationPageResponseDto> {
    const scope = await this.resolveScope(caller);
    const selfPersonId =
      scope.kind === 'self' ? await this.resolveOwnPersonId(caller) : null;

    const { rows, total } = await this.repository.findMany({
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.type === undefined ? {} : { type: query.type }),
      scope,
      selfPersonId,
      page: query.page,
      pageSize: query.pageSize,
    });

    return {
      list: rows.map(toMentorApplicationResponse),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * GET /mentor-applications/:id —— 单条详情。
   * 天花板 `'all'` + 服务里 `assertDeptVisible(filter, 申请人部门)`
   * （brief §0.3）：单条要按院系判越权——不可见是 **403 / 10003**，不是 404。
   * `:id` 不存在或已软删 → **404 / 31104**（先 404 后 403，顺序别调）。
   */
  async findOne(
    id: bigint,
    caller: RequestUser,
  ): Promise<MentorApplicationResponseDto> {
    const application = await this.repository.findDetailById(id);
    if (application === null) {
      throw this.applicationNotFound();
    }
    const scope = await this.resolveScope(caller);
    this.assertApplicantVisible(scope, application);
    return toMentorApplicationResponse(application);
  }

  /**
   * POST /mentor-applications —— 把**当前档案**打包送审（提交即快照）。
   *
   * 资格门（brief §0.3 表，裁定 R52 + R70）：只有 `MentorProfile.status ∈
   * {0 DRAFT, 3 REJECTED}` 能提交；成功后档案推进到 **1 PENDING**——门与推进
   * 是事务内的一条条件更新（repository 的 `updateMany`，原子），`assertSubmittable`
   * 只是前置提示。`2 APPROVED` 报「已入驻」（31101），`1 / 4 / 5` 报 31103——
   * 两个码两件不同的事，前端要按码分流。
   */
  async submitOnboard(
    caller: RequestUser,
  ): Promise<MentorApplicationResponseDto> {
    const person = await this.resolveApplicantPerson(caller);
    const profile = await this.repository.findProfileByPersonId(person.id);
    if (profile === null) {
      throw this.profileNotFound();
    }
    this.assertSubmittable(profile.status);

    const row = await this.repository.createOnboardSubmission({
      applicantId: person.id,
      profileId: profile.id,
      // 快照取「提交当时的档案」：取值在事务内（buildSnapshot 由 repository 在
      // 资格门推进后回读的行上调用），这里只装配映射，不提前算快照
      buildSnapshot: (current) =>
        toProfileDraft(
          this.mentorMapper.toMentorProfileResponse(current, person.personType),
        ),
    });
    if (row === null) {
      // R70 原子资格门没抢到（并发双发的输家）：count=0 一律 31103，不另起新码
      throw this.notSubmittable();
    }
    return toMentorApplicationResponse(row);
  }

  /**
   * `POST /mentor-applications/profile-change` —— 提交信息修改申请（type=2，
   * brief §2 / R56）。入参是 Task 11 的 `UpdateMentorProfileDto`（复用不复制），
   * `type` / `snapshot` / `applicantId` / `profileId` / `status` 服务端定死，
   * 一个都不收（红线 11）。
   *
   * 守卫顺序（brief §2，先到先拒，越权时一个写都不发）：
   *   1. `personType='student'` → 403 / 10003（resolveApplicantPerson）；
   *   2. 无 `MentorProfile` 行 → 404 / 31102；
   *   3. `status ≠ 2 APPROVED` → 409 / 31103（§0.3 表，文案按档分）；
   *   4. 有在审申请 → 409 / 31106（R58，`status ∈ {1,2,4,5}`）；
   *   5. DTO 校验先于一切（全局 ValidationPipe，超长/超量 → 400 / 10001）。
   *
   * 写入（一次事务，只有申请行，**不碰** `MentorProfile`）：`snapshot` 存
   * **R67 的合并结果**——DTO 是增量语义（省略 = 不动、null = 清空、数组 = 整体
   * 替换），合并到当前档案 6 字段上才得到「改完之后的完整样子」；落库后永不
   * 改写（红线 9）。成功留痕 1 行（`targetType='application'`，§4）。
   */
  async submitProfileChange(
    dto: UpdateMentorProfileDto,
    caller: RequestUser,
    meta: ReviewRequestMeta,
  ): Promise<MentorApplicationResponseDto> {
    const started = Date.now();
    const person = await this.resolveApplicantPerson(caller);
    const profile = await this.repository.findProfileByPersonId(person.id);
    if (profile === null) {
      throw this.profileNotFound();
    }
    this.assertProfileChangeSubmittable(profile.status);
    if (await this.repository.hasInFlightApplication(person.id)) {
      throw this.inFlight();
    }

    const row = await this.repository.createProfileChangeSubmission({
      applicantId: person.id,
      profileId: profile.id,
      // R67：合并发生在事务内回读的「当前档案」上，取值时点与 Task 13 同口径
      buildSnapshot: (current) =>
        this.mergeChangeDraft(
          dto,
          this.mentorMapper.toMentorProfileResponse(current, person.personType),
        ),
    });
    if (row === null) {
      // 事务内在审查重没抢到（并发双发的输家）：同判 31106，不另起新码
      throw this.inFlight();
    }

    // §4：提交落第 1 行（targetType='application'）。行 2 只属于 6 APPROVED
    await this.opLog.record({
      module: 'mentor-application',
      action: 'submit-profile-change',
      targetType: 'application',
      targetId: row.id.toString(),
      method: meta.method,
      path: meta.path,
      ...(meta.ip === undefined ? {} : { ip: meta.ip }),
      ...(meta.userAgent === undefined ? {} : { userAgent: meta.userAgent }),
      status: 1,
      // 新建没有「变更前」；after 是落库后的完整状态快照（Task 14 §4 的形状）
      after: {
        status: row.status,
        collegeReview: row.collegeReview,
        scReview: row.scReview,
      },
      durationMs: Date.now() - started,
    });

    return toMentorApplicationResponse(row);
  }

  /**
   * R67 的合并（brief §2 的「不写就会长歪」）：`snapshot` 存**改完之后的完整
   * 6 字段**，不是 DTO 原文。增量语义逐字段落：
   * `undefined` = 不动、`null` = 清空、`researchFields` 传数组 = 整体替换。
   * 不合并就存 DTO 原文的话，一次只改 `summary` 的提案一通过，其余 5 个字段
   * 会被写成 `undefined`/`null`——数据损坏。
   *
   * R49 在这里收口：`mentorType='internal'` 的 `affiliateOrg` / `socialRoles`
   * **恒置 `null`**（「省略 = 不动」对这两列不成立）。
   */
  private mergeChangeDraft(
    dto: UpdateMentorProfileDto,
    current: MentorProfileResponseDto,
  ): MentorProfileDraft {
    const isExternal = current.mentorType === 'external';
    return {
      mentorType: current.mentorType,
      researchFields: dto.researchFields ?? current.researchFields,
      summary: dto.summary === undefined ? current.summary : dto.summary,
      achievements:
        dto.achievements === undefined
          ? current.achievements
          : dto.achievements,
      guidanceExperience:
        dto.guidanceExperience === undefined
          ? current.guidanceExperience
          : dto.guidanceExperience,
      affiliateOrg: isExternal
        ? dto.affiliateOrg === undefined
          ? current.affiliateOrg
          : dto.affiliateOrg
        : null,
      socialRoles: isExternal
        ? dto.socialRoles === undefined
          ? current.socialRoles
          : dto.socialRoles
        : null,
    };
  }

  /**
   * type=2 的提交门（brief §0.3 表）：只有 `2 APPROVED` 能提信息修改申请。
   * 全部非 2 → **409 / 31103**，文案按档分：`0/3` 点名「改草稿走
   * `PUT /mentor/profile`」（别让人以为改字段要走审核流）、`1` 在审、
   * `4/5` 无资格。无档案 / 非 2 不混码：404 / 31102 归「无档案」。
   */
  private assertProfileChangeSubmittable(status: number): void {
    if (status === MENTOR_PROFILE_STATUS.APPROVED) {
      return;
    }

    const message =
      status === MENTOR_PROFILE_STATUS.DRAFT ||
      status === MENTOR_PROFILE_STATUS.REJECTED
        ? '导师档案还是草稿，改草稿走 PUT /mentor/profile'
        : status === MENTOR_PROFILE_STATUS.PENDING
          ? '导师专业档案在审，入驻通过后再提信息修改申请'
          : '导师档案当前状态不允许提交信息修改申请';

    throw new BusinessException(
      ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE,
      message,
      HttpStatus.CONFLICT,
    );
  }

  /** 31106「已有在审的申请，不能重复提交」（R58）：前置查询与事务内复核共用一码一文案 */
  private inFlight(): BusinessException {
    return new BusinessException(
      ErrorCode.MENTOR_APPLICATION_IN_FLIGHT,
      '已有在审的申请，不能重复提交',
      HttpStatus.CONFLICT,
    );
  }

  /**
   * 数据范围（同 user.service.resolveScope 的套路）：角色范围与接口上限求窄。
   * 天花板取 `currentDataScopeCeiling()`（`@DataScope` 声明、拦截器写进上下文）。
   */
  private async resolveScope(caller: RequestUser): Promise<DataScopeFilter> {
    const self = await this.users.findById(caller.userId);
    return this.dataScope.resolve(
      {
        userId: caller.userId,
        isSuperAdmin: caller.isSuperAdmin,
        deptId: self?.deptId ?? null,
      },
      currentDataScopeCeiling(),
    );
  }

  /** 身份链取「自己」的 personId；解析不出（没账号 / 没配人）返回 null → 空集 */
  private async resolveOwnPersonId(
    caller: RequestUser,
  ): Promise<bigint | null> {
    const user = await this.users.findById(caller.userId);
    const person =
      user === null
        ? null
        : await this.repository.findPersonByLogin(user.username);
    return person?.id ?? null;
  }

  /**
   * 单条可见性：`assertDeptVisible(filter, 申请人部门)`，申请人部门 =
   * `applicant.orgUnit.deptId`。申请人没有部门投影时只有 `{kind:'all'}` 看得见
   * （fail-closed，同 review.service 的同名判定）。
   */
  private assertApplicantVisible(
    filter: DataScopeFilter,
    application: MentorApplicationWithApplicant,
  ): void {
    const applicantDeptId = application.applicant.orgUnit?.deptId ?? null;
    if (applicantDeptId === null) {
      if (filter.kind !== 'all') {
        throw new BusinessException(
          ErrorCode.FORBIDDEN,
          '无权限',
          HttpStatus.FORBIDDEN,
        );
      }
      return;
    }
    this.dataScope.assertDeptVisible(filter, applicantDeptId);
  }

  /**
   * 身份门（brief §2 / task-11-brief §0.3 ①）：`personType` 不是导师 →
   * **403 / 10003**，不是 404——「档案不存在」会让人以为再试一次就有了；
   * 学生**永远**不会有导师档案。`SysUser` 查不到 / `SyncPerson` 配不上
   * （软删、同步未及）同判 403：解析不出「导师这个人」，就没有任何申请可提。
   */
  private async resolveApplicantPerson(
    caller: RequestUser,
  ): Promise<SyncPerson> {
    // 红线 14 的运行时绊线（同 mentor.service.ts）：天花板必须是 'self'。
    // ceiling='self' 时不查库、超管也不豁免（data-scope.service.ts）。
    const scope = await this.dataScope.resolve(
      {
        userId: caller.userId,
        isSuperAdmin: caller.isSuperAdmin,
        deptId: null,
      },
      currentDataScopeCeiling(),
    );
    if (scope.kind !== 'self' || scope.userId !== caller.userId) {
      throw new BusinessException(
        ErrorCode.FORBIDDEN,
        '无权限',
        HttpStatus.FORBIDDEN,
      );
    }

    // §2 的身份链：userId → username → login → personId
    const user = await this.users.findById(caller.userId);
    const person =
      user === null
        ? null
        : await this.repository.findPersonByLogin(user.username);

    if (
      person === null ||
      (person.personType !== 'internalMentor' &&
        person.personType !== 'externalMentor')
    ) {
      throw new BusinessException(
        ErrorCode.FORBIDDEN,
        '只有导师（internalMentor / externalMentor）有专业档案',
        HttpStatus.FORBIDDEN,
      );
    }
    return person;
  }

  /**
   * 提交门的**前置提示**（brief §0.3 表）——**不是门**（R70）：真正的资格门是
   * repository 事务内的条件更新，并发双发时两发都可能通过这道提示，输家在
   * `count === 0` 处拿 31103。这里只负责单发场景下把错误码分得更细。
   * 文案是**提交自己的**那句，不复用 R55 那四句（那四句属于 `PUT /mentor/profile`
   * 的写门，已被 test/mentor.e2e-spec.ts 逐字钉死）。`2 APPROVED` 与其余三态
   * 分属两个码：「已入驻」和「在审 / 冻结 / 移出」是三件不同的事，前端按码分流。
   */
  private assertSubmittable(status: number): void {
    // 提交资格与 R55 写门**同一组状态**（{0 DRAFT, 3 REJECTED}），不另起常量
    if (MENTOR_PROFILE_WRITABLE_STATUSES.includes(status)) {
      return;
    }

    if (status === MENTOR_PROFILE_STATUS.APPROVED) {
      throw new BusinessException(
        ErrorCode.MENTOR_ALREADY_ONBOARDED,
        '导师已入驻，不能重复提交入驻申请',
        HttpStatus.CONFLICT,
      );
    }

    // 1 PENDING（在审，不能重复提交）/ 4 FROZEN / 5 REMOVED
    throw this.notSubmittable();
  }

  /** 31103「导师档案当前状态不允许提交入驻申请」：前置提示与原子资格门 miss 共用一码一文案 */
  private notSubmittable(): BusinessException {
    return new BusinessException(
      ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE,
      '导师档案当前状态不允许提交入驻申请',
      HttpStatus.CONFLICT,
    );
  }

  /** 「导师专业档案不存在」：未建档就提交 → 404 / 31102（文案与 31102 的表一致） */
  private profileNotFound(): BusinessException {
    return new BusinessException(
      ErrorCode.MENTOR_PROFILE_NOT_FOUND,
      '导师专业档案不存在',
      HttpStatus.NOT_FOUND,
    );
  }

  /** 「入驻申请不存在」：`:id` 不存在或已软删 → 404 / 31104（Task 14） */
  private applicationNotFound(): BusinessException {
    return new BusinessException(
      ErrorCode.MENTOR_APPLICATION_NOT_FOUND,
      '入驻申请不存在',
      HttpStatus.NOT_FOUND,
    );
  }
}
