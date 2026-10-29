import type {
  SyncOrgUnitRow,
  SyncPersonRow,
  SyncSource,
} from './contract/sync-source';

/**
 * 测试用的同步源。**不是 Nest provider**：`SyncService.runOnce(source)` 把源当参数
 * 收，换对接方就是换一个实现，不改装配。
 *
 * 它无视 `since` 返回全部——这正是契约里那条「给不出增量就退全量」的退化路径（N2），
 * 不是漏实现。真接了学工 / 人事之后由对接方自己按 `since` 过滤。
 */
export class MockSyncSource implements SyncSource {
  readonly name = 'mock';

  orgUnits: SyncOrgUnitRow[] = [];
  persons: SyncPersonRow[] = [];

  /** 设了它，两次 fetch 都抛——用来测「拉数失败 = 整批 FAILED」 */
  fetchError: Error | null = null;

  /**
   * 记下每次收到的 `since`，供用例断言 N2「增量优先」。
   * 只在 `fetchOrgUnits` 记（两个 fetch 是同一次跑，`since` 一定相同）。
   */
  readonly seenSince: Array<Date | null> = [];

  fetchOrgUnits(since: Date | null): Promise<SyncOrgUnitRow[]> {
    this.seenSince.push(since);
    if (this.fetchError !== null) return Promise.reject(this.fetchError);
    return Promise.resolve([...this.orgUnits]);
  }

  /** `since` 不用在这里记——两个 fetch 是同一次跑，值一定相同 */
  fetchPersons(_since: Date | null): Promise<SyncPersonRow[]> {
    if (this.fetchError !== null) return Promise.reject(this.fetchError);
    return Promise.resolve([...this.persons]);
  }
}
