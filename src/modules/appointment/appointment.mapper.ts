import type { Appointment } from '@prisma/client';
import type { AppointmentWithParties } from './appointment.repository';
import { AppointmentResponseDto } from './dto/appointment-response.dto';
import {
  AppointmentDetailDto,
  AppointmentListItemDto,
} from './dto/appointment-list.dto';

/**
 * 实体 → Response DTO 的显式映射（规范 RES-04）。
 *
 * BIGINT 一律对外**字符串**（直接 JSON 化会抛）；时间一律 ISO 8601 字符串（RES-07）。
 */
export function toAppointmentResponse(
  entity: Appointment,
): AppointmentResponseDto {
  return {
    id: entity.id.toString(),
    studentPersonId: entity.studentPersonId.toString(),
    mentorProfileId: entity.mentorProfileId.toString(),
    type: entity.type,
    status: entity.status,
    requestedTime: entity.requestedTime.toISOString(),
    proposedTime: entity.proposedTime?.toISOString() ?? null,
    topic: entity.topic,
    questions: entity.questions,
    mode: entity.mode,
    handleComment: entity.handleComment,
    rejectReason: entity.rejectReason,
    disputeReason: entity.disputeReason,
    adjudicateComment: entity.adjudicateComment,
    slotId: entity.slotId?.toString() ?? null,
  };
}

/**
 * 列表项（Task 30）：预约本身的全字段 + 申请人 / 导师两项联查信息。
 *
 * `orgUnitName` 取 `sync_org_unit.name`。`orgUnit` 在类型上可空（防御同步层把
 * 组织行软删），真为空时落空串——**不编一个假名字**；申请人的 `personId` /
 * `login` / `realName` 仍是真的，前端至少能按 ID 显示。
 */
export function toAppointmentListItem(
  entity: AppointmentWithParties,
): AppointmentListItemDto {
  return {
    ...toAppointmentResponse(entity),
    student: {
      personId: entity.student.id.toString(),
      login: entity.student.login,
      realName: entity.student.realName,
      orgUnitName: entity.student.orgUnit?.name ?? '',
    },
    mentor: {
      mentorProfileId: entity.mentor.id.toString(),
      realName: entity.mentor.person.realName,
      orgUnitName: entity.mentor.person.orgUnit?.name ?? '',
    },
  };
}

/**
 * 详情（Task 30）：列表项 + 更全的学生信息（专业 / 班级 / 电话）。
 * 后三项与 `GuidanceRecordStudentDto` 同形，同步数据没有时为 null。
 */
export function toAppointmentDetail(
  entity: AppointmentWithParties,
): AppointmentDetailDto {
  const item = toAppointmentListItem(entity);
  return {
    ...item,
    student: {
      ...item.student,
      major: entity.student.major,
      className: entity.student.className,
      mobile: entity.student.mobile,
    },
  };
}
