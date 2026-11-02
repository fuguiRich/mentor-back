import { HttpStatus, Injectable } from '@nestjs/common';
import type { MentorProfile, SyncPerson } from '@prisma/client';
import { ErrorCode } from '../../common/constants/error-code';
import {
  currentDataScopeCeiling,
  type RequestUser,
} from '../../common/context/request-context';
import { isDeptInFilter } from '../../common/constants/data-scope';
import { BusinessException } from '../../common/errors/business.exception';
import { DataScopeService } from '../data-scope/data-scope.service';
import { UserService } from '../user/user.service';
import {
  AchievementRepository,
  type AchievementFilter,
  type AchievementPatch,
  type AchievementWrite,
  type ProfileWithDept,
} from './achievement.repository';
import { toAchievementResponse, toDateColumn } from './achievement.mapper';
import type {
  CreateAchievementDto,
  QueryAchievementDto,
  UpdateAchievementDto,
} from './dto/achievement.dto';
import type {
  AchievementListResponseDto,
  AchievementResponseDto,
} from './dto/achievement-response.dto';

/** 导师档案必须处于「已生效」才对外可见（与检索、预约、评价同一口径） */
const MENTOR_PROFILE_APPROVED = 2;

/**
 * 双创成果登记（P3 Task 36 / §5.2）。
 *
 * 两条不变量：
 * 1. **写只能写自己的**。`:mentorId` 不是本人的档案 → **404 / 31102**（藏存在性，
 *    与 P1 时段、P2 时段的做法一致），不是 403——别人的档案存不存在不该被探到。
 * 2. **读按数据范围**。导师看自己的；管理员按部门看；双创学院看全校。
 *    超出范围 → **403 / 10003**（通用码；`32xxx` 是预约段，本域不复用）。
 *
 * 登记即生效（R45）：没有审核状态。§5.4 的「成果关联归档」归 P4。
 */
@Injectable()
export class AchievementService {
  constructor(
    private readonly repository: AchievementRepository,
    private readonly users: UserService,
    private readonly dataScope: DataScopeService,
  ) {}

  /** `POST /mentors/:mentorId/achievements` */
  async create(
    mentorId: bigint,
    dto: CreateAchievementDto,
    caller: RequestUser,
  ): Promise<AchievementResponseDto> {
    const profile = await this.resolveOwnProfile(mentorId, caller);
    const created = await this.repository.create(profile.id, this.toWrite(dto));
    return toAchievementResponse(created);
  }

  /**
   * `GET /mentors/:mentorId/achievements`。
   *
   * 档案不存在 / 未生效 → **404 / 31102**；超出数据范围 → **403 / 10003**。
   */
  async list(
    mentorId: bigint,
    query: QueryAchievementDto,
    caller: RequestUser,
  ): Promise<AchievementListResponseDto> {
    const profile = await this.repository.findProfileWithDept(mentorId);
    if (profile === null || profile.status !== MENTOR_PROFILE_APPROVED) {
      throw this.mentorNotFound();
    }
    await this.assertVisible(profile, caller);

    const [rows, total] = await this.repository.findPage(
      profile.id,
      this.toFilter(query),
      (query.page - 1) * query.pageSize,
      query.pageSize,
    );
    return {
      list: rows.map(toAchievementResponse),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** `PATCH /mentors/:mentorId/achievements/:achievementId`（`type` 不可改） */
  async update(
    mentorId: bigint,
    achievementId: bigint,
    dto: UpdateAchievementDto,
    caller: RequestUser,
  ): Promise<AchievementResponseDto> {
    const profile = await this.resolveOwnProfile(mentorId, caller);
    const existing = await this.repository.findOwnedById(
      profile.id,
      achievementId,
    );
    if (existing === null) {
      throw this.achievementNotFound();
    }
    const patch = this.toPatch(dto);
    // 一个字段都没给：直接回当前行，不发一条空 UPDATE
    if (Object.keys(patch).length === 0) {
      return toAchievementResponse(existing);
    }
    return toAchievementResponse(
      await this.repository.update(existing.id, patch),
    );
  }

  /** `DELETE /mentors/:mentorId/achievements/:achievementId`（软删） */
  async remove(
    mentorId: bigint,
    achievementId: bigint,
    caller: RequestUser,
  ): Promise<{ id: string }> {
    const profile = await this.resolveOwnProfile(mentorId, caller);
    const existing = await this.repository.findOwnedById(
      profile.id,
      achievementId,
    );
    if (existing === null) {
      throw this.achievementNotFound();
    }
    await this.repository.softDelete(existing.id);
    return { id: existing.id.toString() };
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  /** 身份链解析出本人的档案；`:mentorId` 不是它 → 404 / 31102（藏存在性） */
  private async resolveOwnProfile(
    mentorId: bigint,
    caller: RequestUser,
  ): Promise<MentorProfile> {
    const person = await this.resolveCallerPerson(caller);
    const own =
      person === null
        ? null
        : await this.repository.findProfileByPersonId(person.id);
    if (own === null || own.id !== mentorId) {
      throw this.mentorNotFound();
    }
    return own;
  }

  /** 身份链：`caller.userId` → `SysUser.username` → `SyncPerson.login` */
  private async resolveCallerPerson(
    caller: RequestUser,
  ): Promise<SyncPerson | null> {
    const user = await this.users.findById(caller.userId);
    if (user === null) {
      return null;
    }
    return this.repository.findPersonByLogin(user.username);
  }

  /**
   * 读可见性：`all` 全放；`dept` / `deptAndChildren` 看导师所在部门是否在范围内；
   * `self` 只放本人。
   */
  private async assertVisible(
    profile: ProfileWithDept,
    caller: RequestUser,
  ): Promise<void> {
    const user = await this.users.findById(caller.userId);
    const scope = await this.dataScope.resolve(
      {
        userId: caller.userId,
        isSuperAdmin: caller.isSuperAdmin,
        deptId: user?.deptId ?? null,
      },
      currentDataScopeCeiling(),
    );

    if (scope.kind === 'all') {
      return;
    }

    if (scope.kind === 'self') {
      const person =
        user === null
          ? null
          : await this.repository.findPersonByLogin(user.username);
      if (person !== null && person.id === profile.personId) {
        return;
      }
      throw this.forbidden();
    }

    const mentorDeptId = profile.person.orgUnit?.deptId ?? null;
    if (mentorDeptId !== null && isDeptInFilter(scope, mentorDeptId)) {
      return;
    }
    throw this.forbidden();
  }

  private toWrite(dto: CreateAchievementDto): AchievementWrite {
    return {
      type: dto.type,
      title: dto.title,
      level: dto.level,
      awardedAt: toDateColumn(dto.awardedAt),
      description: dto.description ?? null,
      proofFileId:
        dto.proofFileId === undefined || dto.proofFileId === null
          ? null
          : BigInt(dto.proofFileId),
    };
  }

  private toPatch(dto: UpdateAchievementDto): AchievementPatch {
    const patch: AchievementPatch = {};
    if (dto.title !== undefined) {
      patch.title = dto.title;
    }
    if (dto.level !== undefined) {
      patch.level = dto.level;
    }
    if (dto.awardedAt !== undefined) {
      patch.awardedAt = toDateColumn(dto.awardedAt);
    }
    if (dto.description !== undefined) {
      patch.description = dto.description;
    }
    if (dto.proofFileId !== undefined) {
      patch.proofFileId =
        dto.proofFileId === null ? null : BigInt(dto.proofFileId);
    }
    return patch;
  }

  /** `year` → 半开区间 `[YYYY-01-01, (YYYY+1)-01-01)`（R47 同一口径） */
  private toFilter(query: QueryAchievementDto): AchievementFilter {
    const filter: AchievementFilter = {};
    if (query.type !== undefined) {
      filter.type = query.type;
    }
    if (query.level !== undefined) {
      filter.level = query.level;
    }
    if (query.year !== undefined) {
      filter.awardedAtFrom = new Date(Date.UTC(query.year, 0, 1));
      filter.awardedAtTo = new Date(Date.UTC(query.year + 1, 0, 1));
    }
    return filter;
  }

  private mentorNotFound(): BusinessException {
    return new BusinessException(
      ErrorCode.MENTOR_PROFILE_NOT_FOUND,
      '导师专业档案不存在',
      HttpStatus.NOT_FOUND,
    );
  }

  private achievementNotFound(): BusinessException {
    return new BusinessException(
      ErrorCode.ACHIEVEMENT_NOT_FOUND,
      '双创成果不存在',
      HttpStatus.NOT_FOUND,
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
