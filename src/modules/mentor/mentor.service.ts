import { HttpStatus, Injectable } from '@nestjs/common';
import type { SyncPerson } from '@prisma/client';
import { ErrorCode } from '../../common/constants/error-code';
import { isMentorPersonType } from '../../common/constants/person-type';
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
  MentorProfileResponseDto,
  UpdateMentorContactDto,
  UpdateMentorProfileDto,
} from './dto/mentor-profile.dto';
import {
  toMentorProfileResponse,
  toProfileFieldSnapshot,
} from './mentor.mapper';
import {
  MentorRepository,
  type MentorPersonWithOrgUnit,
  type MentorProfileDraftWrite,
} from './mentor.repository';

/**
 * 请求侧的 HTTP 细节（Task 18 的留痕要用）：上下文里没有 method / path / ip /
 * userAgent，控制器从 `@Req()` 取出来传进来（同 mentor-application 的
 * `ReviewRequestMeta`）。
 */
export interface AdminUpdateRequestMeta {
  method: string;
  path: string;
  ip?: string;
  userAgent?: string;
}

/**
 * 导师专业档案（Task 11 + 12）。
 *
 * 「我的」档案怎么解析——**这是本模块的脊梁，不写就会长歪**（brief §4.2）：
 *
 *   1. `caller.userId` → `SysUser`（取 `username`）；
 *   2. `SysUser.username` → `SyncPerson` 按 **`login`** 精确匹配（自然键，
 *      **没有外键**，schema 注释钉的：「SyncPerson → SysUser 不需要对应的列：
 *      那边的自然键是 username」）；
 *   3. `SyncPerson.id` = 本档案的 `personId`；
 *   4. `MentorProfile` where `personId = 上一步的 id`。
 *
 * 「只能改自己的」**不靠入参**（路径与请求体里都没有 id），靠这条链：
 * 解析出来的 personId 只可能是调用者本人的。
 *
 * 数据范围：两条路由都是 `@DataScope('self')`（天花板，红线 14）。行级归属
 * 由上面这条身份链实现——`MentorProfile` 的「自己那一份」按 **personId**（人）
 * 译，不是 generic 的 `created_by = userId`（那是「谁敲的键盘」，换个人代录
 * 一行就把本人挡在门外了）。`assertDeptVisible` 不适用这里：它管的是部门维
 * 传参（user.findPage 的 deptId），而 `isDeptInFilter` 对 `{kind:'self'}`
 * **恒 false**（data-scope.ts 的有意设计），入口也没有部门维入参。
 */
@Injectable()
export class MentorService {
  constructor(
    private readonly repository: MentorRepository,
    private readonly users: UserService,
    private readonly dataScope: DataScopeService,
    private readonly opLog: OpLogService,
  ) {}

  /** GET /mentor/profile。全状态可读——只有写要关（R55），读不关 */
  async findMyProfile(caller: RequestUser): Promise<MentorProfileResponseDto> {
    const person = await this.resolveMentorPerson(caller);
    const profile = await this.repository.findByPersonId(person.id);
    if (profile === null) {
      throw this.notFound();
    }
    return toMentorProfileResponse(profile, person.personType);
  }

  /**
   * PUT /mentor/profile —— **upsert**：没有行就建（`status = 0 DRAFT`），
   * 有行就更新草稿列。GET 不做自动建行（读接口不许有写副作用），
   * 所以未建档时 GET 只能 404（响应的 `id` 非空，合成的空草稿交不出来）。
   *
   * 写之前先过 **R55 status 门**：「草稿」二字不是修辞，是这道门——
   * `status = 2 APPROVED` 的行是对外生效的档案，直接改就把审核流架空了
   * （Task 15 的改字段走 `POST /mentor-applications/profile-change`）。
   */
  async upsertMyProfile(
    dto: UpdateMentorProfileDto,
    caller: RequestUser,
  ): Promise<MentorProfileResponseDto> {
    const person = await this.resolveMentorPerson(caller);
    const draft = this.buildDraft(dto, person);

    const existing = await this.repository.findByPersonId(person.id);
    if (existing === null) {
      // 建行不受 status 门约束——没有行就没有 status，建出来的恒 0
      const created = await this.repository.create(person.id, draft);
      return toMentorProfileResponse(created, person.personType);
    }

    // R55：status ∉ {0 DRAFT, 3 REJECTED} 的行不许被 PUT 改到（409 / 31103）
    this.assertWritableStatus(existing.status);
    const updated = await this.repository.updateDraft(existing.id, draft);
    return toMentorProfileResponse(updated, person.personType);
  }

  /**
   * `PUT /mentor/profile/contact` —— 导师本人维护联系电话。
   *
   * 联系电话是**联系方式**，不是专业资格：不走进驻 / 信息修改申请的审核流，
   * 也不受 R55 的 status 门约束（已生效的导师随时能改）。`null` = 清除覆盖，
   * 展示时回退到同步源的 `SyncPerson.mobile`。
   */
  async updateMyContact(
    dto: UpdateMentorContactDto,
    caller: RequestUser,
  ): Promise<MentorProfileResponseDto> {
    const person = await this.resolveMentorPerson(caller);
    const profile = await this.repository.findByPersonId(person.id);
    if (profile === null) {
      throw this.notFound();
    }
    const updated = await this.repository.updateContact(
      profile.id,
      dto.contactMobile,
    );
    return toMentorProfileResponse(updated, person.personType);
  }

  /**
   * `PUT /mentor/profiles/:id` —— 双创学院管理员改导师填报字段（Task 18）。
   *
   * **不留痕的修改入口一律不给**（计划安全条款）：落库与留痕在同一个
   * `$transaction` 里（repository 的 `adminUpdateProfile`），`opLog.record`
   * 传了 `tx`，写日志失败整件回滚（R77）。
   *
   * 快照是 7 个字段的**完整值**（不是差集）：入参是增量语义，所以先在事务里
   * 读旧行，再把 dto 合并上去得到完整新值——`before` / `after` 都不会出现
   * 「dto 没给的字段是 undefined」。
   *
   * 守卫顺序（先到先拒）：
   *   1. 权限码 / 请求体校验由 Guard / 全局管道挡在 Service 之外（无日志）；
   *   2. `:id` 不存在或已软删 → 404 / 31102（进到 Service 才抛，**有**失败日志）；
   *   3. 档案归属人不在数据范围内 → 403 / 10003。
   *
   * 管理员是纠数据，不看流程态：status 0–5 的行都能改，但**不改 status**。
   */
  async adminUpdateProfile(
    profileId: bigint,
    dto: UpdateMentorProfileDto,
    caller: RequestUser,
    meta: AdminUpdateRequestMeta,
  ): Promise<MentorProfileResponseDto> {
    const started = Date.now();
    let personType: string | null = null;
    try {
      const filter = await this.resolveAdminScope(caller);
      const updated = await this.repository.adminUpdateProfile({
        id: profileId,
        buildDraft: async (before, tx) => {
          const person = await this.repository.findPersonById(
            before.personId,
            tx,
          );
          if (person === null) {
            // 归属人解析不出来（同步未及 / 已软删）：这份档案无处可归
            throw this.notFound();
          }
          await this.assertProfileVisible(filter, person, caller);
          personType = person.personType;
          return this.mergeAdminDraft(
            dto,
            toMentorProfileResponse(before, person.personType),
            person,
          );
        },
        recordLog: async (before, after, tx) => {
          await this.opLog.record(
            {
              module: 'mentor',
              action: 'admin-update-profile',
              targetType: 'mentorProfile',
              targetId: profileId.toString(),
              method: meta.method,
              path: meta.path,
              ...(meta.ip === undefined ? {} : { ip: meta.ip }),
              ...(meta.userAgent === undefined
                ? {}
                : { userAgent: meta.userAgent }),
              status: 1,
              // 完整快照（7 字段），不是差集；键名翻译在 mapper（R68）
              before: toProfileFieldSnapshot(before),
              after: toProfileFieldSnapshot(after),
              durationMs: Date.now() - started,
            },
            tx,
          );
        },
      });

      if (updated === null || personType === null) {
        throw this.notFound();
      }
      return toMentorProfileResponse(updated, personType);
    } catch (error) {
      await this.recordAdminUpdateFailure(profileId, meta, error, started);
      throw error;
    }
  }

  /**
   * 后台改档的合并（R49 在这里收口）：入参是增量语义——`undefined` = 不动、
   * `null` = 清空、`researchFields` 传数组 = 整体替换。不合并就写 dto 原文的话，
   * 只改一个字段会把其余字段写成 undefined（数据损坏）。
   *
   * `mentorType = 'internal'` 的档案，`affiliateOrg` / `socialRoles` **恒置 null**
   * （不是 400）——内校导师没有合作单位与社会任职，管理员也不能替它填。
   * `professionalTitle`（R28）**不受此限**：内校也照常合并，不置 null。
   */
  private mergeAdminDraft(
    dto: UpdateMentorProfileDto,
    current: MentorProfileResponseDto,
    person: SyncPerson,
  ): MentorProfileDraftWrite {
    const isExternal = person.personType === 'externalMentor';
    return {
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
      // R28：内校 / 外校都填，不置空
      professionalTitle:
        dto.professionalTitle === undefined
          ? current.professionalTitle
          : dto.professionalTitle,
    };
  }

  /** 后台改档的数据范围（天花板取 `@DataScope('all')`，角色范围自己收窄） */
  private async resolveAdminScope(
    caller: RequestUser,
  ): Promise<DataScopeFilter> {
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

  /**
   * 目标档案可不可见（R9：装饰器声明上限，Service 算「这一行看不看得到」）。
   * `all` 放行；`depts` 按归属人的组织投影判部门；`self` 只允许改自己那一份。
   * 归属人没有部门投影时 fail-closed（只有 `all` 看得见）。
   */
  private async assertProfileVisible(
    filter: DataScopeFilter,
    target: MentorPersonWithOrgUnit,
    caller: RequestUser,
  ): Promise<void> {
    if (filter.kind === 'all') {
      return;
    }
    if (filter.kind === 'self') {
      const ownPersonId = await this.resolveOwnPersonId(caller);
      if (ownPersonId === target.id) {
        return;
      }
      throw this.forbidden();
    }
    const deptId = target.orgUnit?.deptId ?? null;
    if (deptId === null) {
      throw this.forbidden();
    }
    this.dataScope.assertDeptVisible(filter, deptId);
  }

  /** 调用者本人的 SyncPerson.id（身份链：userId → username → login） */
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
   * 进到 Service 之后的失败留痕（Task 14 的口径）：`:id` 不存在 / 已软删
   * 也要落一行 `status=0`（判据 12 ③）。**不传 `tx`**——失败时没有业务写，
   * 这行是旁路，写失败也不能盖住原错误（`OpLogService.record` 自己 catch）。
   * 权限码 / 请求体校验在 Guard / 管道就被挡下，根本到不了这里。
   */
  private async recordAdminUpdateFailure(
    profileId: bigint,
    meta: AdminUpdateRequestMeta,
    error: unknown,
    started: number,
  ): Promise<void> {
    await this.opLog.record({
      module: 'mentor',
      action: 'admin-update-profile',
      targetType: 'mentorProfile',
      targetId: profileId.toString(),
      method: meta.method,
      path: meta.path,
      ...(meta.ip === undefined ? {} : { ip: meta.ip }),
      ...(meta.userAgent === undefined ? {} : { userAgent: meta.userAgent }),
      status: 0,
      errorCode: toErrorCode(error),
      errorMsg: toErrorMessage(error),
      durationMs: Date.now() - started,
    });
  }

  private forbidden(): BusinessException {
    return new BusinessException(
      ErrorCode.FORBIDDEN,
      '无权限',
      HttpStatus.FORBIDDEN,
    );
  }

  /**
   * 草稿列的组装（**R49 内校置空**在这里落地）：
   * `mentorType = 'external'` 才认 `affiliateOrg` / `socialRoles`；`'internal'`
   * 传了这两个字段**不是报错**，是落库时置 `NULL`——内校导师没有合作单位与
   * 社会任职，留着就是脏数据。为什么不报 400：那会让「从校外转内校」的人
   * 拿着一个合法表单死活交不上去。
   *
   * 其余五列是增量语义：`undefined` = 不动（建行时落 NULL / `[]`）。
   */
  private buildDraft(
    dto: UpdateMentorProfileDto,
    person: SyncPerson,
  ): MentorProfileDraftWrite {
    const isExternal = person.personType === 'externalMentor';
    return {
      researchFields: dto.researchFields,
      summary: dto.summary,
      achievements: dto.achievements,
      guidanceExperience: dto.guidanceExperience,
      // R49：内校置空——传了也丢掉（不是 400）
      affiliateOrg: isExternal ? dto.affiliateOrg : null,
      socialRoles: isExternal ? dto.socialRoles : null,
      // R28：内校 / 外校都填，不置空
      professionalTitle: dto.professionalTitle,
    };
  }

  /**
   * 身份门（brief §0.3 ①）：`personType` 不是导师 → **403 / 10003**，
   * 不是 404——「档案不存在」会让人以为再试一次就有了；学生**永远**不会有
   * 导师档案。`SysUser` 查不到 / `SyncPerson` 配不上（软删、同步未及）同判
   * 403：解析不出「导师这个人」，就没有任何档案可供他操作。
   */
  private async resolveMentorPerson(caller: RequestUser): Promise<SyncPerson> {
    // 红线 14 的运行时绊线：这两条路由的天花板必须是 'self'。有人把
    // `@DataScope('self')` 改宽（'all'）时，resolve 的结果就不再是 self，
    // 这里宁可 403 也不要在档案上开一个宽口。ceiling='self' 时不查库、
    // 超管也不豁免（data-scope.service.ts）。
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

    // §4.2 的身份链：userId → username → login → personId
    const user = await this.users.findById(caller.userId);
    const person =
      user === null
        ? null
        : await this.repository.findPersonByLogin(user.username);

    if (person === null || !isMentorPersonType(person.personType)) {
      throw new BusinessException(
        ErrorCode.FORBIDDEN,
        '只有导师（internalMentor / externalMentor）有专业档案',
        HttpStatus.FORBIDDEN,
      );
    }
    return person;
  }

  /**
   * R55 status 门（task-15-brief §0.1 的表）。文案按 status 分支点名
   * 「为什么改不了、该去哪改」——只说「状态不对」的话，对方只能一轮一轮试。
   *
   * **四个非 `{0,3}` 分支一律 31103（裁定 R75）**，靠**文案**区分四态
   * （在审 / 已生效 / 已冻结 / 已移除），四句逐字不动（test/mentor.e2e 判据 15
   * 钉死）。`31106 = MENTOR_APPLICATION_IN_FLIGHT` 是 R58 在审查重**专用**的
   * 码，这里不借用——混用两个码会让前端按码分流时漏档（§0.2：前端要按码分流）。
   */
  private assertWritableStatus(status: number): void {
    if (MENTOR_PROFILE_WRITABLE_STATUSES.includes(status)) {
      return;
    }

    const message =
      status === MENTOR_PROFILE_STATUS.PENDING
        ? '导师专业档案在审，撤回后再改'
        : status === MENTOR_PROFILE_STATUS.APPROVED
          ? '导师专业档案已生效，改字段走信息修改申请'
          : status === MENTOR_PROFILE_STATUS.FROZEN
            ? '导师专业档案已冻结，不能修改'
            : '导师专业档案已移除，不能修改';

    throw new BusinessException(
      ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE,
      message,
      HttpStatus.CONFLICT,
    );
  }

  /** 「导师专业档案不存在」只此一处定义（GET 未建档 → 404 / 31102） */
  private notFound(): BusinessException {
    return new BusinessException(
      ErrorCode.MENTOR_PROFILE_NOT_FOUND,
      '导师专业档案不存在',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * 取出业务错误码 / 文案写进操作日志（同 review.service / file.service 的同名
 * 函数）：`BusinessException` 的 `{code, message}` 在响应体里，不在错误对象
 * 自己身上。
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
