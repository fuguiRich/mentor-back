/**
 * 同步模块的精确值。**取值不许换**：`SyncRun.status` 的四个数是 schema 注释里
 * 钉死的，角色 code 服从 `role.constants.ts` 的 `ROLE_CODE_PATTERN`，
 * `DETAIL_REASON` 的字符串要进 `SyncRun.detail` 的 JSON——那是给运维读的契约。
 */

/** `SyncRun.status`。序号与 `prisma/schema.prisma` 的 `SyncRun` 注释逐字一致 */
export const SyncRunStatus = {
  RUNNING: 0,
  OK: 1,
  PARTIAL: 2,
  FAILED: 3,
} as const;

export type SyncRunStatusValue =
  (typeof SyncRunStatus)[keyof typeof SyncRunStatus];

/**
 * `personType` → 建号时绑定的默认角色 code（Ruling 24）。
 *
 * 三类 `personType` 与四类角色是两个维度（Ruling 4）：导师在 §1.2 的四类里只有一类，
 * 内外之别是数据（`SyncPerson.personType`）不是权限，所以两类都映到 `mentor`。
 * 另两个角色 `college_admin` / `sc_admin` **不在这里**——管理员不在同步源里，
 * 由超管建号绑角色（Task 6b）。
 *
 * **只在建号那一次用**：之后不再改绑，管理员加的角色不该被下一次同步抹掉。
 */
export const PERSON_TYPE_ROLE_CODE = {
  student: 'student',
  internalMentor: 'mentor',
  externalMentor: 'mentor',
} as const;

/**
 * `SyncRun.detail` 里 `failure.reason` 的机器可读取值。
 * 形状是 `` `${reason}` `` 或 `` `${reason}:${补充}` ``，如 `role_missing:mentor`。
 */
export const DETAIL_REASON = {
  /** 找不到默认角色（角色是管理员配的，同步任务不自建） */
  ROLE_MISSING: 'role_missing',
  /** 人员所属单位在本批 + 库里都找不到 */
  ORG_NOT_FOUND: 'org_not_found',
  /** 组织树成环，断在这几行上 */
  ORG_CYCLE: 'org_cycle',
  /** Prisma P2002，撞 DB-11 的生成列唯一键 */
  UNIQUE_KEY_CONFLICT: 'unique_key_conflict',
  /** 兜底 */
  EXCEPTION: 'exception',
} as const;

/** `exception:` 后面的消息截断长度。理由要够定位，不能把整个堆栈塞进 JSON 列 */
export const SYNC_REASON_MAX_LEN = 200;

/** 一行的失败记录，落 `SyncRun.detail.failures[]`（ERR-07：不许静默吞） */
export interface SyncRunFailure {
  kind: 'orgUnit' | 'person';
  /** orgUnit 用 `code`，person 用 `login` */
  key: string;
  /** `` `${DETAIL_REASON.X}` `` 或 `` `${DETAIL_REASON.X}:${补充}` `` */
  reason: string;
}

/** `SyncRun.detail` 的 JSON 形状 */
export interface SyncRunDetail {
  mode: 'incremental' | 'full';
  /** ISO 字符串；全量时 `null` */
  since: string | null;
  failures: SyncRunFailure[];
}
