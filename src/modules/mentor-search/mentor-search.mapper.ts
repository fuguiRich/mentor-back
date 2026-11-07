import { Injectable } from '@nestjs/common';
import { MentorMapperProvider } from '../mentor/mentor-mapper.provider';
import type { MentorProfileResponseDto } from '../mentor/dto/mentor-profile.dto';
import {
  MentorSearchDetailResponseDto,
  MentorSearchItemResponseDto,
} from './dto/mentor-search-response.dto';
import type {
  MentorSearchDetailRow,
  MentorSearchRow,
} from './mentor-search.repository';

/**
 * 检索结果 → Response DTO 的显式映射（RES-04）。
 *
 * `mentorType` 的推导与 `researchFields` 的 JSON 兜底读**借
 * `MentorMapperProvider`**（MentorModule 的对外映射面，LAYER-06）：既不跨模块
 * 直接 import 对方内部的 `mentor.mapper`，也不在本模块抄第二份推导 / 第二张
 * 键名表（同 mentor-application 的复用口径）。
 *
 * 这里只从它的响应里取需要的字段：检索的展示面比档案响应窄（无 `status` /
 * `personId`），但 `mentorType` 与 `researchFields` 的取值口径必须与档案一致。
 */
@Injectable()
export class MentorSearchMapper {
  constructor(private readonly mentorMapper: MentorMapperProvider) {}

  toItem(row: MentorSearchRow): MentorSearchItemResponseDto {
    return this.toItemFrom(row, this.toProfile(row));
  }

  toDetail(row: MentorSearchDetailRow): MentorSearchDetailResponseDto {
    const profile = this.toProfile(row);
    return {
      ...this.toItemFrom(row, profile),
      // 档案响应的键名是 `achievements`（R68 的键名翻译收口），检索契约叫
      // `researchAchievements`（与 Prisma 列名同源，计划 §Task 22 逐字）
      researchAchievements: profile.achievements,
      guidanceExperience: profile.guidanceExperience,
      affiliateOrg: profile.affiliateOrg,
      socialRoles: profile.socialRoles,
      // 导师本人维护的联系电话优先；未填时回退同步源手机号
      mobile: row.contactMobile ?? row.person.mobile,
      timeSlots: row.timeSlots.map((slot) => ({
        id: slot.id.toString(),
        mentorProfileId: slot.mentorProfileId.toString(),
        weekday: slot.weekday,
        startTime: slot.startTime,
        endTime: slot.endTime,
        status: slot.status,
      })),
    };
  }

  private toProfile(row: MentorSearchRow): MentorProfileResponseDto {
    return this.mentorMapper.toMentorProfileResponse(
      row,
      row.person.personType,
    );
  }

  private toItemFrom(
    row: MentorSearchRow,
    profile: MentorProfileResponseDto,
  ): MentorSearchItemResponseDto {
    return {
      id: profile.id,
      name: row.person.realName,
      mentorType: profile.mentorType,
      deptName: row.person.orgUnit.name,
      professionalTitle: profile.professionalTitle,
      researchFields: profile.researchFields,
      summary: profile.summary,
    };
  }
}
