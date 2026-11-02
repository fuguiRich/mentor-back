import { GuidanceRecordResponseDto } from './dto/guidance-record-response.dto';
import type { GuidanceRecordWithStudent } from './appointment.repository';

/**
 * 指导记录实体 → Response DTO 的显式映射（规范 RES-04）。
 *
 * BIGINT 一律对外**字符串**（直接 JSON 化会抛）；时间一律 ISO 8601 字符串
 * （RES-07）。`student` 来自 `record.appointment.student` 的联查（R27）。
 */
export function toGuidanceRecordResponse(
  record: GuidanceRecordWithStudent,
): GuidanceRecordResponseDto {
  const student = record.appointment.student;
  return {
    id: record.id.toString(),
    appointmentId: record.appointmentId.toString(),
    actualTime: record.actualTime.toISOString(),
    mode: record.mode,
    coreContent: record.coreContent,
    followUp: record.followUp,
    submittedBy: record.submittedBy.toString(),
    submittedAt: record.submittedAt.toISOString(),
    // P3 Task 35 / R58：存量记录是 0（「未填」），不是「零分钟」
    durationMinutes: record.durationMinutes,
    student: {
      realName: student.realName,
      login: student.login,
      major: student.major,
      className: student.className,
      mobile: student.mobile,
    },
  };
}
