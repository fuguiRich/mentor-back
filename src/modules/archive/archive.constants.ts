/**
 * 归档域的精确值（P4 Task 52 / §4.7）。
 *
 * `targetType` 是**弱关联**：不校验目标是否存在（R? / 计划 §错误码 37003 留空），
 * 因为归档要活过被归档实体的软删。白名单只约束「写进来的类型是这五类之一」。
 */
export const ARCHIVE_TARGET_TYPES = [
  'MentorApplication',
  'Assessment',
  'GuidanceRecord',
  'Achievement',
  'Other',
] as const;

export type ArchiveTargetType = (typeof ARCHIVE_TARGET_TYPES)[number];

/** 管理员**手工**归档允许的 category（`mentor-application` / `assessment` 只能由自动挂点写） */
export const MANUAL_ARCHIVE_CATEGORIES = [
  'guidance-record',
  'achievement',
  'other',
] as const;

export type ManualArchiveCategory = (typeof MANUAL_ARCHIVE_CATEGORIES)[number];

/** 检索时可用的全部 category（手工 + 自动） */
export const ARCHIVE_CATEGORIES = [
  'mentor-application',
  'assessment',
  ...MANUAL_ARCHIVE_CATEGORIES,
] as const;

/** `SysConfig` 键：非核心材料的保留天数（默认 1825 = 5 年） */
export const ARCHIVE_NONCORE_RETENTION_DAYS_CODE =
  'archive.noncore_retention_days';

export const DEFAULT_ARCHIVE_NONCORE_RETENTION_DAYS = 1825;

/** `SysConfig` 键：过期清理定时任务开关（默认关，生产先人工跑） */
export const ARCHIVE_PURGE_ENABLED_CODE = 'archive.purge_enabled';
