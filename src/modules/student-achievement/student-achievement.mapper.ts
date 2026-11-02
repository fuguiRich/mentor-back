import type { StudentAchievement } from '@prisma/client';
import { toDateOnlyString } from '../archive/archive.time';
import type { StudentAchievementResponseDto } from './dto/student-achievement-response.dto';

/** 带学生姓名的实体投影 */
export type StudentAchievementWithStudent = StudentAchievement & {
  student: { realName: string };
};

/** 实体 → 响应 DTO（RES-04：显式映射） */
export function toStudentAchievementResponse(
  row: StudentAchievementWithStudent,
): StudentAchievementResponseDto {
  return {
    id: row.id.toString(),
    studentPersonId: row.studentPersonId.toString(),
    studentName: row.student.realName,
    mentorProfileId: row.mentorId === null ? null : row.mentorId.toString(),
    achievementId:
      row.achievementId === null ? null : row.achievementId.toString(),
    deptId: row.deptId === null ? null : row.deptId.toString(),
    type: row.type,
    title: row.title,
    level: row.level,
    awardedAt: toDateOnlyString(row.awardedAt),
    proofFileId: row.proofFileId === null ? null : row.proofFileId.toString(),
    linkedAt: row.linkedAt === null ? null : row.linkedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
