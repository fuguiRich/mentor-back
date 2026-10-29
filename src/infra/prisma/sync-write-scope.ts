import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 同步任务的写入作用域。
 *
 * `SyncPerson` / `SyncOrgUnit` 的真相在源系统，本系统只是落一份副本。业务代码
 * 写进去的那一行，下次同步就被冲掉——而且**没人会发现**，因为同步是批量覆盖的，
 * 冲掉的那行看起来就像「源系统本来就是这样」。所以这两张表默认拒绝一切写入，
 * 只有包在 `runWithSyncWrite` 里的同步任务能写（见 prisma.extension.ts 的守卫）。
 *
 * 「能写」= create / createMany / update / updateMany / upsert。**硬删不在其中**：
 * `delete` / `deleteMany` 在软删除表上被 R24 那道守卫一并拒掉（在同步作用域里
 * 也一样），同步任务的「离场」是 `update({ data: { deletedAt, deletedBy } })`
 * （需求 §2.1 就是软删 / 标记离场）。
 *
 * 用 `AsyncLocalStorage` 而不是一个模块级布尔开关：同步任务跑在请求上下文之外，
 * 但一个布尔变量会让「两个同步任务重叠跑」互相把对方的门打开。ALS 按异步调用链
 * 隔离，重叠的两条链各自持有自己的作用域。
 */
const syncWriteScope = new AsyncLocalStorage<true>();

/**
 * 在同步写入作用域里跑 `fn`。只有同步任务该调它。
 *
 * **`await` 必须落在 `run()` 里面**，所以这里写 `await fn()` 而不是 `return fn()`。
 * Prisma 的 `PrismaPromise` 是惰性的：查询要到 `.then()` 才真正启动。写
 * `return fn()` 时，`fn()` 同步交回的只是那颗惰性 promise，`.then()` 由**调用方**
 * 的 `await` 触发——那时早已跑出 `run()` 的作用域，扩展里的 `isSyncWriteScope()`
 * 读到 false，同步任务会被自己那道门拒掉。`await fn()` 把 `.then()` 留在作用域内。
 *
 * 不是假想的坑：test/sync-write-guard.e2e-spec.ts 的「create 落库」两条用例
 * 在 `return fn()` 下就是红的。
 */
export async function runWithSyncWrite<T>(fn: () => Promise<T>): Promise<T> {
  return syncWriteScope.run(true, async () => {
    return await fn();
  });
}

/** 当前调用链是否在同步写入作用域内。 */
export function isSyncWriteScope(): boolean {
  return syncWriteScope.getStore() === true;
}
