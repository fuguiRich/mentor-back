import { Injectable, Logger } from '@nestjs/common';
import type { SyncOrgUnit, SyncRun } from '@prisma/client';
import { runWithSyncWrite } from '../../infra/prisma/sync-write-scope';
import type {
  SyncMode,
  SyncOrgUnitRow,
  SyncPersonRow,
  SyncSource,
} from './contract/sync-source';
import { ProjectionWriter, type UserProjection } from './projection';
import {
  DETAIL_REASON,
  PERSON_TYPE_ROLE_CODE,
  SYNC_REASON_MAX_LEN,
  SyncRunStatus,
  type SyncRunDetail,
  type SyncRunFailure,
  type SyncRunStatusValue,
} from './sync.constants';
import { SyncOrgRepository } from './sync-org.repository';
import { SyncPersonRepository } from './sync-person.repository';
import { SyncRunRepository } from './sync-run.repository';

/** 一次同步跑完的回执。`runId` 供调用方回查 `SyncRun.detail` */
export interface SyncRunResult {
  runId: bigint;
  source: string;
  mode: SyncMode;
  status: SyncRunStatusValue;
  total: number;
  okCount: number;
  failCount: number;
  failures: SyncRunFailure[];
}

/** 计数器。`okCount + failCount === total` 恒成立（见 `runOnce` 的口径） */
interface Tally {
  total: number;
  okCount: number;
  failCount: number;
  failures: SyncRunFailure[];
}

/**
 * 一行的结局。**每一行只记一次**：`null` = 成功，字符串 = 失败原因。
 * 把「记账」留在调用侧，是因为一行可能在好几处失败，而 `total` 只能加一次。
 */
type RowOutcome = string | null;

function record(
  tally: Tally,
  kind: SyncRunFailure['kind'],
  key: string,
  outcome: RowOutcome,
): void {
  tally.total += 1;
  if (outcome === null) {
    tally.okCount += 1;
    return;
  }
  tally.failCount += 1;
  tally.failures.push({ kind, key, reason: outcome });
}

/** `role_missing:mentor` 这种形状。不带补充就是裸的 `role_missing` */
function detailReason(base: string, extra?: string): string {
  return extra === undefined ? base : `${base}:${extra}`;
}

/**
 * 同一批里出现重复自然键 = 源数据坏了。后到的那条记 `unique_key_conflict`、
 * 不进后续处理。
 *
 * 不去重的话，`topoSort` 的 `byCode` 与内容趟的 `byCode` 都按 `code` 收敛，
 * 两条源行会被合成一行账——`total` 就不等于「本次处理的行数」（Ruling 26），
 * 而且其中一条要是写失败了，另一条的 `record` 也会跟着丢。
 */
function dedupeBy<T>(
  rows: T[],
  key: (row: T) => string,
  kind: SyncRunFailure['kind'],
  tally: Tally,
): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const row of rows) {
    const k = key(row);
    if (seen.has(k)) {
      record(tally, kind, k, DETAIL_REASON.UNIQUE_KEY_CONFLICT);
      continue;
    }
    seen.add(k);
    kept.push(row);
  }
  return kept;
}

function exceptionReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return detailReason(
    DETAIL_REASON.EXCEPTION,
    message.slice(0, SYNC_REASON_MAX_LEN),
  );
}

/** Prisma 的唯一键冲突。**不要吞成通用异常**——DB-11 的生成列唯一键是并发兜底，
 *  撞上它说明两条同步链写到了同一行，要能一眼看出来 */
function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

function reasonOf(error: unknown): string {
  return isUniqueConflict(error)
    ? DETAIL_REASON.UNIQUE_KEY_CONFLICT
    : exceptionReason(error);
}

/**
 * 父先于子的顺序。**一遍写完解决不了「儿子先到、父亲后到」**，
 * 而 `SysDept.parentId` 要父的 `deptId`，更得等父先投影完。
 *
 * 成环的那几行单独拎出来——环不是「找不到父」，是源数据本身坏了，
 * 混进 `org_not_found` 会让运维去查一个根本不存在的编码。
 */
function topoSort(rows: SyncOrgUnitRow[]): {
  ordered: SyncOrgUnitRow[];
  cycles: SyncOrgUnitRow[];
} {
  const byCode = new Map(rows.map((row) => [row.code, row]));
  const ordered: SyncOrgUnitRow[] = [];
  const cycleCodes = new Set<string>();
  const state = new Map<string, 'visiting' | 'done'>();
  /** 当前这条递归链，用来在撞上自己时把**整段环**拎出来，不是只记回头那一行 */
  const path: SyncOrgUnitRow[] = [];

  const visit = (row: SyncOrgUnitRow): void => {
    const seen = state.get(row.code);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      const at = path.findIndex((r) => r.code === row.code);
      for (const r of path.slice(at === -1 ? 0 : at)) cycleCodes.add(r.code);
      return;
    }
    state.set(row.code, 'visiting');
    path.push(row);
    const parent =
      row.parentCode === null ? undefined : byCode.get(row.parentCode);
    if (parent !== undefined) visit(parent);
    path.pop();
    state.set(row.code, 'done');
    ordered.push(row);
  };

  for (const row of rows) visit(row);
  return {
    ordered,
    cycles: rows.filter((row) => cycleCodes.has(row.code)),
  };
}

/**
 * 同步编排（规格 §2.1 + §2.4）。**判断都在这里，写入在 repository / projection。**
 *
 * 跑法：拉数 → 落同步层 → 投影到 `SysDept` / `SysUser` → 记流水。
 * 整个写阶段包在 `runWithSyncWrite` 里（Ruling 15：作用域内必须 `await fn()`）。
 *
 * **一行落不下去不拖垮整批**：记进 `SyncRun.detail.failures`、`failCount++`，
 * 继续跑下一行（ERR-07：失败不许静默吞）。
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly runs: SyncRunRepository,
    private readonly orgs: SyncOrgRepository,
    private readonly persons: SyncPersonRepository,
    private readonly projection: ProjectionWriter,
  ) {}

  /**
   * 跑一次同步（启动 + 执行）。调度器与测试用这个入口。
   *
   * 计数口径：`total` = 本次处理的行数 = 本批行数（org + person）+ 全量跑里
   * 被离场的行数。**`okCount + failCount === total` 恒成立**——它是这条流水
   * 最基本的自检，别让它对不上。
   */
  async runOnce(
    source: SyncSource,
    options: { mode?: SyncMode } = {},
  ): Promise<SyncRunResult> {
    const last = await this.runs.findLastUsableStartedAt(source.name);
    const mode: SyncMode =
      options.mode === 'full' ? 'full' : last === null ? 'full' : 'incremental';
    const run = await this.startRun(source, { mode });
    return this.executeRun(source, run, { mode });
  }

  /**
   * 开一条 RUNNING 流水。**有效 mode 在这里定**：请求增量但没有可用水位
   * （第一次跑 / 上一次 FAILED）→ 全量。手动触发接口用它拿到 runId 后后台执行。
   */
  async startRun(
    source: SyncSource,
    options: { mode: SyncMode },
  ): Promise<SyncRun> {
    const last = await this.runs.findLastUsableStartedAt(source.name);
    const effective: SyncMode =
      options.mode === 'full' ? 'full' : last === null ? 'full' : 'incremental';
    return this.runs.start(source.name, effective);
  }

  /** 执行一条已经开好的流水。只认 `run.mode`，不再反推。 */
  async executeRun(
    source: SyncSource,
    run: SyncRun,
    options: { mode: SyncMode },
  ): Promise<SyncRunResult> {
    const mode: SyncMode =
      run.mode === 'incremental' || run.mode === 'full'
        ? run.mode
        : options.mode;
    // PARTIAL 也推进水位；FAILED 不推进。减 5 分钟重叠，避免同步过程中更新的行
    // 落在 startedAt..finishedAt 之间而漏掉。
    const last =
      mode === 'full'
        ? null
        : await this.runs.findLastUsableStartedAt(source.name);
    const since =
      last === null ? null : new Date(last.getTime() - 5 * 60 * 1000);

    const tally: Tally = { total: 0, okCount: 0, failCount: 0, failures: [] };

    // 拉数失败是**整批失败**，不是某一行失败：源都够不着，谈不上逐行对账
    let orgRows: SyncOrgUnitRow[] = [];
    let personRows: SyncPersonRow[] = [];
    try {
      orgRows = await source.fetchOrgUnits(since);
      personRows = await source.fetchPersons(since);
    } catch (error: unknown) {
      this.logger.error(`拉数失败：${String(error)}`);
      record(tally, 'orgUnit', source.name, exceptionReason(error));
    }

    if (tally.failures.length === 0) {
      try {
        await runWithSyncWrite(async () => {
          await this.syncOrgUnits(orgRows, run.id, tally, source);
          await this.syncPersons(personRows, run.id, tally);
          if (mode === 'full')
            await this.retireAbsent(orgRows, personRows, tally, source);
        });
      } catch (error: unknown) {
        // 批级逃逸：不是哪一行的锅，但流水必须收口。记在 source 名下
        // （与上面拉数失败同一形状）。不收口的话 `runs.finish` 不会被调用，
        // `SyncRun` 永远停在 RUNNING，前面已经记下的 failures 也跟着丢。
        // 注意这**不等于整批回滚**：作用域不是事务，已经写下去的还在。
        this.logger.error(`同步写阶段逃逸：${String(error)}`);
        record(tally, 'orgUnit', source.name, exceptionReason(error));
      }
    }

    const status = this.decideStatus(tally);
    const detail: SyncRunDetail | null =
      tally.failures.length === 0
        ? null
        : {
            mode,
            since: since === null ? null : since.toISOString(),
            failures: tally.failures,
          };

    const finished = await this.runs.finish(run.id, {
      status,
      total: tally.total,
      okCount: tally.okCount,
      failCount: tally.failCount,
      detail,
    });

    return {
      runId: finished.id,
      source: source.name,
      mode,
      status,
      total: tally.total,
      okCount: tally.okCount,
      failCount: tally.failCount,
      failures: tally.failures,
    };
  }

  /** 状态判定（口径写在 brief 2.4，四个取值不许换序号） */
  private decideStatus(tally: Tally): SyncRunStatusValue {
    if (tally.failCount > 0 && tally.okCount === 0) return SyncRunStatus.FAILED;
    if (tally.failCount > 0) return SyncRunStatus.PARTIAL;
    return SyncRunStatus.OK;
  }

  // ---------- 组织 ----------

  private async syncOrgUnits(
    rows: SyncOrgUnitRow[],
    runId: bigint,
    tally: Tally,
    source: SyncSource,
  ): Promise<void> {
    const syncedAt = new Date();
    /** 去重后的批：重复自然键的那几条已在 `dedupeBy` 里记过账，不进后续 */
    const batch = dedupeBy(rows, (row) => row.code, 'orgUnit', tally);
    /** `code` → 本批这一行的库内行。内容阶段先落，树阶段要用它的 id */
    const byCode = new Map<string, SyncOrgUnit>();
    /** 内容阶段就失败的行：树阶段跳过，不重复记账 */
    const dead = new Set<string>();

    for (const row of batch) {
      try {
        const content = {
          name: row.name,
          kind: row.kind,
          syncedAt,
          syncRunId: runId,
        };
        const existing = await this.orgs.findByCode(row.code);
        if (existing === null) {
          byCode.set(row.code, await this.orgs.create(row.code, content));
        } else {
          // 内容全同就不写：幂等判据要求同一批跑两次表内容不变。
          // `syncedAt` / `syncRunId` 跟着内容走，所以也不在这一步写
          const changed =
            existing.name !== content.name ||
            existing.kind !== content.kind ||
            existing.deletedAt !== null;
          if (changed) await this.orgs.updateContent(existing.id, content);
          byCode.set(row.code, existing);
        }
      } catch (error: unknown) {
        dead.add(row.code);
        record(tally, 'orgUnit', row.code, reasonOf(error));
      }
    }

    const { ordered, cycles } = topoSort(batch);
    const cycleCodes = new Set(cycles.map((row) => row.code));
    for (const row of ordered) {
      if (dead.has(row.code)) continue;
      if (cycleCodes.has(row.code)) {
        record(tally, 'orgUnit', row.code, DETAIL_REASON.ORG_CYCLE);
        continue;
      }
      const unit = byCode.get(row.code);
      if (unit === undefined) continue;
      let outcome: RowOutcome = null;
      try {
        outcome = await this.linkAndProject(row, unit, byCode, source);
      } catch (error: unknown) {
        outcome = reasonOf(error);
      }
      record(tally, 'orgUnit', row.code, outcome);
    }
  }

  /**
   * 挂上级 + 投影出 `SysDept`。返回失败原因或 `null`。
   *
   * 父的 `deptId` 必须已经在这：它是上一轮（或本轮更早的一步）投影出来的。
   * 是 `null` 就说明父自己还没投影成功——这一行挂不上去，记失败。
   * 本轮因此是 PARTIAL，**水位不推进**（Ruling 25），下一次增量还会把这一行
   * 原样捞出来重试，父投影好了它就挂上去了。
   */
  private async linkAndProject(
    row: SyncOrgUnitRow,
    unit: SyncOrgUnit,
    byCode: Map<string, SyncOrgUnit>,
    source: SyncSource,
  ): Promise<RowOutcome> {
    let parentId: bigint | null = null;
    let parentDeptId: bigint | null = null;
    if (row.parentCode !== null) {
      const parent =
        byCode.get(row.parentCode) ??
        (await this.orgs.findByCode(row.parentCode));
      if (parent === null || parent === undefined || parent.deptId === null) {
        return detailReason(DETAIL_REASON.ORG_NOT_FOUND, row.parentCode);
      }
      parentId = parent.id;
      parentDeptId = parent.deptId;
    }
    const desired = {
      name: row.name,
      parentId: parentDeptId,
      sortOrder: 0,
      status: 1,
      remark: null,
    };
    let current = await this.orgs.linkParent(unit, parentId);
    let existing =
      current.deptId === null
        ? null
        : await this.projection.findDept(current.deptId);

    // 源根复用本地已有的根部门，避免出现「总部 + 长沙医学院」两个根；
    // 否则旧根会在离场里被软删，`sc_admin` 的数据范围一起落空。
    if (existing === null && row.parentCode === null && source.reuseRootDept) {
      existing = await this.projection.findRootDept();
    }

    if (existing === null) {
      // 本地已有同级同名部门（演示数据 / 历史数据）时复用，避免撞
      // sys_dept 的 (parent_id, name_active) 唯一键。
      const sibling = await this.projection.findDeptByParentAndName(
        desired.parentId,
        desired.name,
      );
      if (sibling !== null) {
        const linked = await this.orgs.findByDeptId(sibling.id);
        if (linked === null || linked.id === current.id) {
          current = await this.orgs.linkDept(current, sibling.id);
          byCode.set(row.code, current);
          return null;
        }
        // 已被别的同步行占用：换一个本地名，不能把两个源部门并成一个
        const dept = await this.projection.createDept({
          ...desired,
          name: `${desired.name}（${row.code}）`,
        });
        current = await this.orgs.linkDept(current, dept.id);
        byCode.set(row.code, current);
        return null;
      }
      const dept = await this.projection.createDept(desired);
      current = await this.orgs.linkDept(current, dept.id);
    } else {
      // 之前因为同名冲突被加了后缀的本地部门，后续同步不能把名字改回源名——
      // 那会再次撞上 (parent_id, name_active) 唯一键。保留已有本地名。
      const sibling = await this.projection.findDeptByParentAndName(
        desired.parentId,
        desired.name,
      );
      const name =
        sibling !== null && sibling.id !== existing.id
          ? existing.name
          : desired.name;
      await this.projection.updateDept(existing, { ...desired, name });
      current = await this.orgs.linkDept(current, existing.id);
    }
    // 刷新这一趟的 `code → 行` 表：后面的子行要读它刚拿到的 `deptId`。
    // 不刷的话，同一趟里「父先投影完、子再找父」会读到建行时的 null，
    // 子被误判成 `org_not_found`。
    byCode.set(row.code, current);
    return null;
  }

  // ---------- 人员 ----------

  private async syncPersons(
    rows: SyncPersonRow[],
    runId: bigint,
    tally: Tally,
  ): Promise<void> {
    const syncedAt = new Date();
    /** 去重后的批：同上，重复 `login` 的那几条已记过账 */
    const batch = dedupeBy(rows, (row) => row.login, 'person', tally);

    for (const row of batch) {
      let outcome: RowOutcome = null;
      try {
        const orgUnit = await this.orgs.findByCode(row.orgUnitCode);
        if (orgUnit === null || orgUnit.deptId === null) {
          outcome = detailReason(DETAIL_REASON.ORG_NOT_FOUND, row.orgUnitCode);
        } else {
          const content = {
            realName: row.realName,
            personType: row.personType,
            orgUnitId: orgUnit.id,
            major: row.major,
            className: row.className,
            mobile: row.mobile,
            syncedAt,
            syncRunId: runId,
          };
          const existing = await this.persons.findByLogin(row.login);
          if (existing === null) {
            await this.persons.create(row.login, content);
          } else {
            const changed =
              existing.realName !== content.realName ||
              existing.personType !== content.personType ||
              existing.orgUnitId !== content.orgUnitId ||
              existing.major !== content.major ||
              existing.className !== content.className ||
              existing.mobile !== content.mobile ||
              existing.deletedAt !== null;
            if (changed) await this.persons.updateContent(existing.id, content);
          }
          outcome = await this.projectPerson(row, orgUnit.deptId);
        }
      } catch (error: unknown) {
        outcome = reasonOf(error);
      }
      record(tally, 'person', row.login, outcome);
    }
  }

  /**
   * 投影到 `SysUser`。**人员信息归源系统，登录态与角色归本地**：
   * 建号写一次密码与 `status = 1`，之后同步不再碰它们（唯一的例外是源系统删人时
   * 把 `status` 收成 0，见 {@link retireAbsent}）。
   */
  private async projectPerson(
    row: SyncPersonRow,
    deptId: bigint,
  ): Promise<RowOutcome> {
    const desired: UserProjection = {
      // `username` 与 `employeeNo` 都取 login：SSO 走 `findByEmployeeNo` 找本地号，
      // 而 `username` 是 `uk_sys_user_username_active` 的那一列
      username: row.login,
      employeeNo: row.login,
      realName: row.realName,
      mobile: row.mobile,
      deptId,
      // 同步源来的人都是 SSO 账号；管理员手工建号走 UserRepository.createWithRoles
      authSource: 'sso',
    };
    const roleCode = PERSON_TYPE_ROLE_CODE[row.personType];
    const roleId = await this.projection.findRoleIdByCode(roleCode);

    const user = await this.projection.findUser(row.login);
    if (user === null) {
      // 角色是**管理员配的**，同步任务不自建。缺角色就整行失败——
      // 建一个没角色的号比不建更坏：它能登录，但什么都看不见
      if (roleId === null) {
        return detailReason(DETAIL_REASON.ROLE_MISSING, roleCode);
      }
      const created = await this.projection.createUser(desired);
      await this.projection.bindRole(created.id, roleId);
      return null;
    }

    await this.projection.updateUser(user, desired);
    // **0 个角色才补默认角色**。有角色就不再碰——管理员给某人加了
    // 「二级学院管理员」，下一次同步不该把它抹掉（Ruling 24）
    if (
      roleId !== null &&
      (await this.projection.countUserRoles(user.id)) === 0
    ) {
      await this.projection.bindRole(user.id, roleId);
    }
    return null;
  }

  // ---------- 离场 ----------

  /**
   * 全量跑才认「批里没有 = 源系统删了」（Ruling 23）。
   * 增量批里少一行只说明「这次没变」，不说明「没了」。
   *
   * 落法是**软删**，不是 delete：`delete` 连同步作用域里也被 R24 拒
   * （离场没有第二条路），而且历史业务数据要能继续关联到人（N1）。
   * `SysUser` 只收 `status = 0`——账号停用但不消失。
   *
   * **两笔写的先后顺序是安全边界，不能调换**。`runWithSyncWrite` 只是
   * AsyncLocalStorage 作用域，**不是事务**，中途抛异常不回滚：
   *
   * | 顺序 | 第二笔抛了之后 | 后果 |
   * | --- | --- | --- |
   * | 先软删同步行 | 同步行 `deleted_at` 已落，`listActive()` 再也看不到它 | **永不重试**。源系统删掉的人 `status` 一直是 1，SSO 一直进得来；删掉的部门一直挂在数据权限里 |
   * | 先投影、后软删 | 账号还没停，同步行还在 | 落在安全的一边，下一次跑原样补上 |
   *
   * 所以一律**先收投影、最后才软删同步行**。代价是偶尔出现
   * 「账号已停用、同步行还没标离场」的中间态，那是可自愈的；
   * 反过来那个中间态不可自愈。
   */
  private async retireAbsent(
    orgRows: SyncOrgUnitRow[],
    personRows: SyncPersonRow[],
    tally: Tally,
    source: SyncSource,
  ): Promise<void> {
    const scope = source.retirementScope;
    const presentOrgs = new Set(orgRows.map((row) => row.code));
    for (const unit of await this.orgs.listActive()) {
      if (presentOrgs.has(unit.code)) continue;
      // 只处理本数据源负责的行：mock / 历史组织不因 SSO 全量而消失
      if (
        scope?.orgCodePrefix !== undefined &&
        !unit.code.startsWith(scope.orgCodePrefix)
      ) {
        continue;
      }
      // 根行永远不删：它可能被多个源共享，删掉会连带软删根部门
      if (unit.parentId === null) continue;
      let outcome: RowOutcome = null;
      try {
        if (unit.deptId !== null) {
          await this.projection.softDeleteDept(unit.deptId);
        }
        await this.orgs.softDelete(unit.id);
      } catch (error: unknown) {
        outcome = exceptionReason(error);
      }
      record(tally, 'orgUnit', unit.code, outcome);
    }

    const presentPersons = new Set(personRows.map((row) => row.login));
    for (const person of await this.persons.listActive()) {
      if (presentPersons.has(person.login)) continue;
      // 只处理本数据源负责的人员类型：外校导师不由 SSO 管
      if (
        scope?.personTypes !== undefined &&
        !scope.personTypes.includes(person.personType)
      ) {
        continue;
      }
      let outcome: RowOutcome = null;
      try {
        const user = await this.projection.findUser(person.login);
        // 管理员手工建的本地账号即使有同名同步行，也不因 SSO 离场被停用
        if (
          scope?.authSources !== undefined &&
          (user === null || !scope.authSources.includes(user.authSource))
        ) {
          continue;
        }
        if (user !== null) await this.projection.disableUser(user.id);
        await this.persons.softDelete(person.id);
      } catch (error: unknown) {
        outcome = exceptionReason(error);
      }
      record(tally, 'person', person.login, outcome);
    }
  }
}
