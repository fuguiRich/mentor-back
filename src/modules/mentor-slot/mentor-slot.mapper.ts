import type { MentorTimeSlot } from '@prisma/client';
import { SlotResponseDto } from './dto/slot-response.dto';

/**
 * 实体 → Response DTO 的显式映射（规范 RES-04）。
 * BIGINT 一律对外**字符串**（直接 JSON 化会抛）。
 */
export function toSlotResponse(entity: MentorTimeSlot): SlotResponseDto {
  return {
    id: entity.id.toString(),
    mentorProfileId: entity.mentorProfileId.toString(),
    weekday: entity.weekday,
    startTime: entity.startTime,
    endTime: entity.endTime,
    status: entity.status,
  };
}
