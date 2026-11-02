import { HttpStatus, Injectable } from '@nestjs/common';
import type { MentorProfile } from '@prisma/client';
import { ErrorCode } from '../../common/constants/error-code';
import {
  currentDataScopeCeiling,
  type RequestUser,
} from '../../common/context/request-context';
import { BusinessException } from '../../common/errors/business.exception';
import { DataScopeService } from '../data-scope/data-scope.service';
import { UserService } from '../user/user.service';
import type { CreateSlotDto } from './dto/create-slot.dto';
import { SLOT_STATUS } from './dto/create-slot.dto';
import type {
  SlotListResponseDto,
  SlotResponseDto,
} from './dto/slot-response.dto';
import type { UpdateSlotDto } from './dto/update-slot.dto';
import { toSlotResponse } from './mentor-slot.mapper';
import { MentorSlotRepository, type SlotWrite } from './mentor-slot.repository';

/**
 * 导师可指导时段管理（Task 21）。
 *
 * 「只能操作自己的时段」是**两道**，缺一不可：
 *   1. `@DataScope('self')` 是接口天花板（红线），Service 里另有一道绊线——
 *      有人把装饰器改宽时宁可 403 也不开宽口；
 *   2. 行级归属靠身份链解析出本人的 `MentorProfile.id`，再按
 *      `{ id, mentorProfileId }` 取行——别人的 `:id` 取不到，一律 **404 / 31201**
 *      （藏存在性，**不是** 403）。
 *
 * 重叠判定是半开区间 `[start, end)`：同一导师、同一 weekday 的时段不得相交，
 * 首尾相接不算冲突（`findOverlapping` 的两条不等式）。
 */
@Injectable()
export class MentorSlotService {
  constructor(
    private readonly repository: MentorSlotRepository,
    private readonly users: UserService,
    private readonly dataScope: DataScopeService,
  ) {}

  /** `GET /mentor/slots` —— 本人的全部未删时段（全量一页） */
  async list(caller: RequestUser): Promise<SlotListResponseDto> {
    const profile = await this.resolveMentorProfile(caller);
    const rows = await this.repository.findManyByProfile(profile.id);
    const list = rows.map(toSlotResponse);
    return { list, total: list.length, page: 1, pageSize: list.length };
  }

  /**
   * `POST /mentor/slots` —— 新建时段。
   * 守卫顺序：无档案 404 / 31102 → 与本人已有时段重叠 409 / 31206 → 落库。
   */
  async create(
    dto: CreateSlotDto,
    caller: RequestUser,
  ): Promise<SlotResponseDto> {
    const profile = await this.resolveMentorProfile(caller);
    const slot = this.toSlotWrite(dto, SLOT_STATUS.OPEN);
    await this.assertNoOverlap(profile.id, slot);
    const created = await this.repository.create(profile.id, slot);
    return toSlotResponse(created);
  }

  /**
   * `PUT /mentor/slots/:id` —— 整条替换（见 UpdateSlotDto 的说明）。
   * 守卫顺序：无档案 404 / 31102 → 时段不存在 / 不属于本人 404 / 31201 →
   * 重叠（排除自己那一行）409 / 31206 → 写回。
   */
  async update(
    id: bigint,
    dto: UpdateSlotDto,
    caller: RequestUser,
  ): Promise<SlotResponseDto> {
    const profile = await this.resolveMentorProfile(caller);
    const existing = await this.repository.findOwnedById(id, profile.id);
    if (existing === null) {
      throw this.slotNotFound();
    }
    // status 省略 = 保留原值（不是回到默认 1）：关掉的时段改时间不该被悄悄打开
    const slot = this.toSlotWrite(dto, existing.status);
    await this.assertNoOverlap(profile.id, slot, existing.id);
    const updated = await this.repository.update(existing.id, slot);
    return toSlotResponse(updated);
  }

  /**
   * `DELETE /mentor/slots/:id` —— 软删。
   * 守卫顺序：无档案 404 / 31102 → 时段不存在 / 不属于本人 404 / 31201 → 软删。
   */
  async remove(id: bigint, caller: RequestUser): Promise<void> {
    const profile = await this.resolveMentorProfile(caller);
    const existing = await this.repository.findOwnedById(id, profile.id);
    if (existing === null) {
      throw this.slotNotFound();
    }
    await this.repository.softDelete(existing.id);
  }

  /**
   * 请求体 → 可写列。`id` / `mentorProfileId` 绝不来自请求（DTO-12：显式挑字段，不透传）。
   *
   * `status` 省略时取 `fallbackStatus`：新建传 `SLOT_STATUS.OPEN`（默认开放），
   * 更新传**原值**（关着的时段保持关闭）。`null` 到不了这里——DTO 层已 400。
   */
  private toSlotWrite(
    dto: CreateSlotDto | UpdateSlotDto,
    fallbackStatus: number,
  ): SlotWrite {
    return {
      weekday: dto.weekday,
      startTime: dto.startTime,
      endTime: dto.endTime,
      status: dto.status ?? fallbackStatus,
    };
  }

  /** 与本人同 weekday 的已有未删时段相交 → 409 / 31206（更新时排除自己） */
  private async assertNoOverlap(
    mentorProfileId: bigint,
    slot: SlotWrite,
    excludeId?: bigint,
  ): Promise<void> {
    const overlapping = await this.repository.findOverlapping(
      mentorProfileId,
      slot.weekday,
      slot.startTime,
      slot.endTime,
      excludeId,
    );
    if (overlapping !== null) {
      throw this.slotConflict();
    }
  }

  /**
   * 身份链 + 天花板绊线（同 mentor.service 的 resolveMentorPerson）：
   * `caller.userId` → `SysUser.username` → `SyncPerson.login` → `personId` →
   * `MentorProfile`。解析不出档案（含学生 / 同步未及）一律 **404 / 31102**
   * ——本任务的判据就是「导师无档案 → 404 / 31102」。
   *
   * 绊线：`@DataScope('self')` 被改宽时 `resolve` 不再返回 self，这里宁可 403。
   */
  private async resolveMentorProfile(
    caller: RequestUser,
  ): Promise<MentorProfile> {
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
    const profile =
      person === null
        ? null
        : await this.repository.findProfileByPersonId(person.id);
    if (profile === null) {
      throw this.profileNotFound();
    }
    return profile;
  }

  /** 403 / 10003「无权限」：天花板绊线不过（@DataScope('self') 被改宽） */
  private forbidden(): BusinessException {
    return new BusinessException(
      ErrorCode.FORBIDDEN,
      '无权限',
      HttpStatus.FORBIDDEN,
    );
  }

  /** 404 / 31102「导师专业档案不存在」：复用 P1 的码与文案 */
  private profileNotFound(): BusinessException {
    return new BusinessException(
      ErrorCode.MENTOR_PROFILE_NOT_FOUND,
      '导师专业档案不存在',
      HttpStatus.NOT_FOUND,
    );
  }

  /** 404 / 31201「可指导时段不存在」：不存在 / 已软删 / 不属于本人同码同文案 */
  private slotNotFound(): BusinessException {
    return new BusinessException(
      ErrorCode.MENTOR_SLOT_NOT_FOUND,
      '可指导时段不存在',
      HttpStatus.NOT_FOUND,
    );
  }

  /** 409 / 31206：同一导师同一 weekday 的时段区间相交 */
  private slotConflict(): BusinessException {
    return new BusinessException(
      ErrorCode.MENTOR_SLOT_OVERLAP,
      '该时段与已有开放时段重叠',
      HttpStatus.CONFLICT,
    );
  }
}
