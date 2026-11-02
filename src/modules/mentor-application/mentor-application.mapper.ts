import type { MentorApplication } from '@prisma/client';
import type { MentorProfileResponseDto } from '../mentor/dto/mentor-profile.dto';
import {
  MentorProfileDraft,
  type MentorApplicationResponseDto,
  type MentorApplicationStatus,
  type MentorApplicationType,
} from './dto/mentor-application-response.dto';
import type { ReviewRecord } from './dto/review.dto';

/**
 * 实体 → Response DTO 的显式映射（RES-04）。
 * BIGINT 一律对外**字符串**（直接 JSON 化会抛）。响应不含任何密码 / 令牌类字段。
 */

/** JSON 列的兜底读：坏数据不该把接口打成 500（写口只有一处，形状已校验） */
function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * 提交时的快照组装：响应 DTO 的可填报字段照搬成 `MentorProfileDraft`
 * （brief §3）。
 *
 * **键名翻译不在这里做**（裁定 R68）：`achievements` 的 Prisma 标量名是
 * `researchAchievements`（P3 关系占了 `achievements`），翻译只在 mentor 模块
 * 的 `toMentorProfileResponse` 里出现一次——本模块经 MentorModule 导出的
 * `MentorMapperProvider` 注入复用它（LAYER-06），不抄第二张键名表，
 * 业务代码一行都不点名 `researchAchievements`。
 *
 * 快照是**提交当时的档案**逐字段搬运（含 R49 落库时已置空的内校两列），
 * 不在这里做任何改写。
 */
export function toProfileDraft(
  current: MentorProfileResponseDto,
): MentorProfileDraft {
  return {
    mentorType: current.mentorType,
    researchFields: current.researchFields,
    summary: current.summary,
    achievements: current.achievements,
    guidanceExperience: current.guidanceExperience,
    affiliateOrg: current.affiliateOrg,
    socialRoles: current.socialRoles,
    professionalTitle: current.professionalTitle,
  };
}

/**
 * `snapshot` JSON 列 → 响应形状。只做形状归一，**不改值**（快照不可变）。
 * 导出给 review.service 的落地写用（Task 15）：写回的值从 `snapshot` 取，
 * 归一后逐字段搬运（红线 9），不重读当前行、不改写已落库的快照。
 *
 * **旧快照兼容（Task 20c / R28）**：`professionalTitle` 是后加的键，Task 20c
 * 之前落库的快照没有它——`toStringOrNull(undefined)` 返回 `null`，**不抛错**。
 */
export function normalizeProfileDraft(value: unknown): MentorProfileDraft {
  const draft = (value ?? {}) as Record<string, unknown>;
  return {
    mentorType: draft.mentorType === 'external' ? 'external' : 'internal',
    researchFields: toStringArray(draft.researchFields),
    summary: toStringOrNull(draft.summary),
    achievements: toStringOrNull(draft.achievements),
    guidanceExperience: toStringOrNull(draft.guidanceExperience),
    affiliateOrg: toStringOrNull(draft.affiliateOrg),
    socialRoles: toStringOrNull(draft.socialRoles),
    professionalTitle: toStringOrNull(draft.professionalTitle),
  };
}

/**
 * `collegeReview` / `scReview` 的 JSON 列读 → `ReviewRecord`（Task 14 定死的形状）。
 *
 * 只做**形状归一**，不改值。写口只有 review.service 一处（字段五件套齐着写），
 * 这里的缺字段兜底只为「历史垃圾数据不该把接口打成 500」而存在——
 * 空串兜底不造假时间 / 不假审核人（RES-07 的精神：缺失就是缺失）。
 */
function toReviewRecord(value: unknown): ReviewRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    reviewerId: typeof record.reviewerId === 'string' ? record.reviewerId : '',
    reviewerName:
      typeof record.reviewerName === 'string' ? record.reviewerName : '',
    decision: record.decision === 'reject' ? 'reject' : 'approve',
    comment: typeof record.comment === 'string' ? record.comment : '',
    at: typeof record.at === 'string' ? record.at : '',
  };
}

export function toMentorApplicationResponse(
  entity: MentorApplication,
): MentorApplicationResponseDto {
  return {
    id: entity.id.toString(),
    type: entity.type as MentorApplicationType,
    applicantId: entity.applicantId.toString(),
    snapshot: normalizeProfileDraft(entity.snapshot),
    status: entity.status as MentorApplicationStatus,
    collegeReview: toReviewRecord(entity.collegeReview),
    scReview: toReviewRecord(entity.scReview),
    // P1 的两条创建路径都必写 submittedAt；null 只在理论上的 0 DRAFT 行出现，
    // 兜底空串不做假时间（RES-07 的 ISO 串由 Date 承诺，缺失就是缺失）
    submittedAt: entity.submittedAt?.toISOString() ?? '',
  };
}
