import type { MentorProfile } from '@prisma/client';
import {
  MentorProfileResponseDto,
  type MentorProfileStatus,
} from './dto/mentor-profile.dto';

/**
 * `SyncPerson.personType` → 响应的 `mentorType`。
 *
 * **不落列**（schema 注释钉的）：冗余一份就会跟同步源漂移。学生走不到这里
 * ——身份门在 Service 先拦（403），但这里仍按「非 externalMentor 即 internal」
 * 收窄成两值，好让类型是字面量联合而不是 string。
 */
export function deriveMentorType(personType: string): 'internal' | 'external' {
  return personType === 'externalMentor' ? 'external' : 'internal';
}

/** JSON 列的兜底读：坏数据不该把 GET 打成 500，落成 [] 即可（写口只有一处，形状已校验） */
function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * 留痕快照的形状（Task 18 §4）：7 个可填报字段的**完整取值**，不是差集。
 *
 * 键名是响应 DTO 的（`achievements`）——`researchAchievements` 这个 Prisma
 * 标量名只在本文件出现（R68 的键名翻译收口），业务代码不点名它。
 */
export interface ProfileFieldSnapshot {
  researchFields: string[];
  summary: string | null;
  achievements: string | null;
  guidanceExperience: string | null;
  affiliateOrg: string | null;
  socialRoles: string | null;
  professionalTitle: string | null;
}

/** 实体 → 留痕快照（键名翻译在这一处，调用方只拿 DTO 键名） */
export function toProfileFieldSnapshot(
  entity: MentorProfile,
): ProfileFieldSnapshot {
  return {
    researchFields: toStringArray(entity.researchFields),
    summary: entity.summary,
    achievements: entity.researchAchievements,
    guidanceExperience: entity.guidanceExperience,
    affiliateOrg: entity.affiliateOrg,
    socialRoles: entity.socialRoles,
    professionalTitle: entity.professionalTitle,
  };
}

/**
 * 实体 → Response DTO 的显式映射（规范 RES-04）。
 * BIGINT 一律对外**字符串**（直接 JSON 化会抛）。响应不含任何密码 / 令牌类字段。
 */
export function toMentorProfileResponse(
  entity: MentorProfile,
  personType: string,
): MentorProfileResponseDto {
  return {
    id: entity.id.toString(),
    personId: entity.personId.toString(),
    mentorType: deriveMentorType(personType),
    researchFields: toStringArray(entity.researchFields),
    summary: entity.summary,
    achievements: entity.researchAchievements,
    guidanceExperience: entity.guidanceExperience,
    affiliateOrg: entity.affiliateOrg,
    socialRoles: entity.socialRoles,
    professionalTitle: entity.professionalTitle,
    status: entity.status as MentorProfileStatus,
  };
}
