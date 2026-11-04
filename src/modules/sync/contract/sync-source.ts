/**
 * 同步源的对外契约。**对接方按这个实现**，本系统只认这两张表的形状。
 *
 * 行里用 `code` / `login` 互相引用，不用 id：源系统不知道我们的 id，
 * 而它的 id 与我们的自增 id 撞车是必然的（两边各从 1 开始）。
 */

/**
 * 增量还是全量。取值不是给实现方挑的——`SyncService` 传 `since` 就是增量，
 * 传 `null` 就是全量，实现方给不出增量时无视 `since` 返回全部即可（N2）。
 */
export type SyncMode = 'incremental' | 'full';

/** 同步来的组织单元（学院 / 系所树），对应 `SyncOrgUnit`。 */
export interface SyncOrgUnitRow {
  /** 源系统的单位编码，配行的自然键 */
  code: string;
  name: string;
  /** 上级编码；顶层为 `null` */
  parentCode: string | null;
  /** 学院 / 系所 / 其他，源给什么存什么，本系统不裁 */
  kind: string | null;
}

/** 同步来的人员，对应 `SyncPerson`。 */
export interface SyncPersonRow {
  /** 学号 / 工号，配行的自然键，也是 `SysUser.username` 与 `employeeNo` */
  login: string;
  realName: string;
  personType: 'student' | 'internalMentor' | 'externalMentor' | 'teacher';
  /** 所属单位编码，必须能对上一条 `SyncOrgUnitRow.code` */
  orgUnitCode: string;
  major: string | null;
  className: string | null;
  mobile: string | null;
}

/**
 * 外部数据源。按对接方实现；本期只有 {@link import('../mock-source').MockSyncSource}。
 *
 * `since` 为 `null` 表示全量（N2）。**退化责任在实现方**：给不出增量的实现
 * 无视 `since` 返回全部即可，本系统不替它判断「哪些变了」。
 */
export interface SyncSource {
  /** 数据源标识，落 `SyncRun.source`（如 `mock` / `xg` / `rs`）。自描述，免得调用方传错串 */
  readonly name: string;
  fetchOrgUnits(since: Date | null): Promise<SyncOrgUnitRow[]>;
  fetchPersons(since: Date | null): Promise<SyncPersonRow[]>;
}
