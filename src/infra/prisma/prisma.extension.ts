import { Prisma } from '@prisma/client';
import { HttpStatus } from '@nestjs/common';
import { currentActorId } from '../../common/context/request-context';
import { ErrorCode } from '../../common/constants/error-code';
import { BusinessException } from '../../common/errors/business.exception';
import {
  auditCreateManyData,
  auditData,
  withNotDeleted,
} from './audit-args.util';
import { isSyncWriteScope } from './sync-write-scope';

/**
 * 有软删除字段的表。连接表（sys_user_role / sys_role_permission）
 * 刻意不在其中——它们物理删除（规范 DB-10），因为软删除会让
 * 「撤销授权后重新授予」撞上 (user_id, role_id) 的唯一约束。
 * `SysOpLog` 同样不在其中：它是 append-only 的日志，没有 deleted_at 列，
 * 也没有任何删改入口（保留期由归档策略管）。
 */
const SOFT_DELETE_MODELS = new Set<string>([
  'SysDept',
  'SysUser',
  'SysRole',
  'SysPermission',
  'SysDictType',
  'SysDictItem',
  'SysConfig',
  'SysFile',
  // 同步层也有 deleted_at（需求 N1：源系统删行 → 软删），接上同一套过滤，
  // 免得每个读点自己记得带 `deletedAt: null`。写入另有一道更严的守卫（见下）。
  'SyncOrgUnit',
  'SyncPerson',
  // Task 5 建的 13 个业务模型都有 deleted_at，但登记要**各自任务引入时补**——
  // 一次全加等于替后面的任务做决定。Task 11 补 MentorProfile 这一个；
  // Task 13 补 MentorApplication，以此类推。
  'MentorProfile',
  'MentorApplication',
  // Task 16 补这一个：摘材料是软删（R63），软删后同一 fileId 允许再挂——
  // 唯一性按「未删行」算，靠读过滤天然成立
  'MentorApplicationMaterial',
]);

/**
 * 同步层的表：真相在源系统，本系统只落副本。
 *
 * 业务代码写进去的那一行，下次同步就被批量覆盖冲掉——而且**没人会发现**，
 * 因为覆盖之后的样子跟「源系统本来就是这样」一模一样。所以这两张表默认拒绝
 * 一切写入，只有包在 `runWithSyncWrite` 里的同步任务能写（sync-write-scope.ts）。
 *
 * 守卫有两层：一层看顶层 `model`，一层顺着 args 扫嵌套写（下文「嵌套写守卫」）。
 */
const SYNC_OWNED_MODELS = new Set<string>(['SyncOrgUnit', 'SyncPerson']);

/** 同步层表上被拒的操作。与 append-only 同一个道理：用黑名单，读操作永不误杀。 */
const SYNC_OWNED_FORBIDDEN = new Set<string>([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

// ─── 嵌套写守卫 ────────────────────────────────────────────────────────
//
// 顶层守卫只看 `model`，而 Prisma 的**嵌套写跑在父查询里**：`query` 扩展对
// `prisma.mentorProfile.create({ data: { person: { create: … } } })` 只回调一次，
// `model === 'MentorProfile'`。里面的那条 SyncPerson 写入根本不经过本扩展的
// `$allOperations`，守卫看都没看到——生成的
// `SyncPersonCreateNestedOneWithoutProfilesInput` 确实开放 create / connectOrCreate /
// update / upsert。所以要顺着 args 自己往里钻（见 assertNoNestedSyncWrite）。
//
// **绕不过的口子**：`$executeRaw` / `$queryRaw` / `$transaction` 里的裸 SQL 是手写
// SQL，Prisma 的查询扩展一个都不触发。那类调用在这个仓库里的边界（裁定 R78）：
// **写**语句（INSERT / UPDATE / DELETE）只能出现在同步任务与迁移脚本里，靠 code
// review 看住，不是这道守卫的责任；只读行锁 `SELECT … FOR UPDATE` 例外——只许
// 这一种、只许在事务里当第一句（如 mentor-application.repository.ts 收 R58 的
// TOCTOU 窗口）。任何裸 INSERT / UPDATE / DELETE 在业务代码里仍然绝对禁止。

/**
 * 字段元数据：模型名 →（字段名 → 关系元数据，或 `null` 表示非关系字段）。
 *
 * 从 `Prisma.dmmf` 现取，不手抄：schema 里关系一多，手写映射表就是下一个漂移点。
 * `fkOnSelf === true` 表示外键在**本**模型上（`relationFromFields` 非空），
 * 这时 `connect` 只改本行的外键；外键在目标侧时，连 `connect` 都是在改目标行。
 *
 * **非关系字段也要登记**，光有关系表不够：args 里的包装器键（`data` / `create` /
 * `update`）不是字段名，而 JSON / 标量字段的值**不是**字段表。分不出这两者，
 * 就会把 JSON 列里恰好叫 `person` 的数据当嵌套写误拒（见 walkNode 的注释）。
 */
interface RelationMeta {
  target: string;
  fkOnSelf: boolean;
}

function buildFieldMap(): Map<string, Map<string, RelationMeta | null>> {
  const map = new Map<string, Map<string, RelationMeta | null>>();
  for (const model of Prisma.dmmf.datamodel.models) {
    const fields = new Map<string, RelationMeta | null>();
    for (const field of model.fields) {
      fields.set(
        field.name,
        field.kind === 'object'
          ? {
              target: field.type,
              fkOnSelf: (field.relationFromFields?.length ?? 0) > 0,
            }
          : null,
      );
    }
    map.set(model.name, fields);
  }
  return map;
}

const FIELDS = buildFieldMap();

/** 嵌套写的动词。与 where 的关系过滤（is / some / every / none）不搭界。 */
const NESTED_WRITE_OPS = new Set<string>([
  'create',
  'createMany',
  'connect',
  'connectOrCreate',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  'disconnect',
  'set',
]);

/**
 * 会往**目标模型**里写行的动词。`connect` / `disconnect` / `set` 不在其列：
 * 外键在本侧时它们只改本行的 FK，目标行一个字节都不动。
 * 外键在目标侧时这条区分不成立，walkRelation 里整包拒。
 */
const WRITES_TARGET_OPS = new Set<string>([
  'create',
  'createMany',
  'connectOrCreate',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

/** 能携带嵌套写的操作。读操作与 delete 的 where 不带，扫了也是白扫。 */
const NESTED_WRITE_CARRIERS = new Set<string>([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
]);

/**
 * args 里装字段表的包装器键。它们**不是**字段名，但值是本模型的字段表
 * （`create` / `update` 是 upsert 的两个分支，`data` 是 create/update 的载荷，
 * `where` 是 update/upsert 的条件）。
 *
 * 按名字硬判而不是只看「是不是本模型的字段」：万一某个模型有叫 `data` 的标量列，
 * 「是字段就跳过」会把包装器一起跳掉——那是**漏检**（fail-open），比误拒坏得多。
 * 顺序因此是：关系字段（嵌套写挂这）> 包装器 > 标量 / JSON。
 */
const ARGS_WRAPPERS = new Set<string>(['data', 'create', 'update', 'where']);

/**
 * 拒掉 args 里任何「写进同步层」的嵌套写，任意深度。
 *
 * 走法：往下钻时只关心两件事——当前模型的**关系字段**（值是嵌套写规格），
 * 以及包装器键（`data` / `create` / `update` / upsert 的 create+update）里的字段表。
 * 三类键分得清才不会走偏：
 *   · 关系字段 → walkRelation（值是 `{ create | connect | upsert | … }`）
 *   · 非关系字段 → **不下钻**。它的值是标量或 JSON，不是字段表；
 *     JSON 里恰好叫 `person` 的键只是数据，嵌套写挂在**关系字段**上，不会出现在这里。
 *   · 不是字段名的键 → 包装器，继续钻（字段表就躺在这些键下面）。
 */
function assertNoNestedSyncWrite(model: string, args: unknown): void {
  walkNode(model, args);
}

function walkNode(model: string, node: unknown): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkNode(model, item);
    return;
  }
  const fields = FIELDS.get(model);
  for (const [key, value] of Object.entries(node)) {
    // 1) 关系字段优先——嵌套写就挂在这，任何情况下都要看
    const relation = fields?.get(key);
    if (relation) {
      walkRelation(relation, value);
      continue;
    }
    // 2) 包装器：值是本模型的字段表，继续钻
    if (ARGS_WRAPPERS.has(key) || !fields?.has(key)) {
      walkNode(model, value);
      continue;
    }
    // 3) 非关系字段：值是标量 / 枚举 / JSON，不是字段表，不下钻。
  }
}

function walkRelation(relation: RelationMeta, node: unknown): void {
  if (node === null || typeof node !== 'object') return;
  const specs: unknown[] = Array.isArray(node) ? node : [node];
  for (const spec of specs) {
    if (spec === null || typeof spec !== 'object') continue;
    for (const [op, payload] of Object.entries(spec)) {
      if (!NESTED_WRITE_OPS.has(op)) continue; // select / include / where 过滤：读
      // 外键在本侧时，connect/disconnect/set 只改本行；外键在目标侧时无一幸免
      const writesTarget = !relation.fkOnSelf || WRITES_TARGET_OPS.has(op);
      if (
        writesTarget &&
        SYNC_OWNED_MODELS.has(relation.target) &&
        !isSyncWriteScope()
      ) {
        throw new BusinessException(
          ErrorCode.SYNC_WRITE_FORBIDDEN,
          `禁止业务代码写入同步层的 ${relation.target}（嵌套写 ${op}）：` +
            '人与组织的真相在源系统，本系统的副本由同步任务维护。' +
            '要挂上一条同步来的记录请用 connect；要改内容请去改源系统。',
          HttpStatus.FORBIDDEN,
        );
      }
      walkNode(relation.target, payload);
    }
  }
}

/**
 * append-only 的表：只插，不改不删。
 *
 * `SysOpLog` 是留痕，删掉一条就少一条真相，而且删了没人会知道。它没有
 * deleted_at，所以上面的软删除守卫拦不住它——那道守卫只管「有软删字段的表」。
 * 这里补的是另一半：**没有任何入口能让它变短**。保留期由归档策略在库外管
 * （清旧分区 / dump 后 DROP），不在业务代码里开一个「清理日志」的口子。
 */
const APPEND_ONLY_MODELS = new Set<string>(['SysOpLog']);

/**
 * append-only 表上被拒的操作。用**黑名单**而不是白名单：新增一个读操作
 * （例如 Prisma 后续加的某个统计 API）不该因为没登记而被误杀。
 */
const APPEND_ONLY_FORBIDDEN = new Set<string>([
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

/** 需要追加「未删除」过滤的读操作 */
const READ_OPERATIONS = new Set<string>([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

interface QueryParams {
  model?: string;
  operation: string;
  args: Record<string, unknown>;
  query: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface AuditedExtensionOptions {
  /** false 时只做审计填充、不做软删除过滤，供 includingDeleted 使用 */
  softDelete: boolean;
}

/**
 * 审计字段自动填充（规范 DB-05）+ 软删除（DB-09）。
 *
 * 两件事写在同一个扩展里而不是拆成两个：它们共享同一次
 * 「当前操作者是谁、现在几点」的计算，拆开要么重复取值，
 * 要么就得依赖两个扩展的叠加顺序——顺序依赖是那种改动时没人会想起来的耦合。
 */
export function createAuditedExtension(options: AuditedExtensionOptions) {
  return Prisma.defineExtension((client) =>
    client.$extends({
      name: 'auditedSoftDelete',
      query: {
        $allModels: {
          async $allOperations(raw: unknown): Promise<unknown> {
            const { model, operation, args, query } = raw as QueryParams;
            if (!model) {
              return query(args);
            }

            const actor = currentActorId();
            const now = new Date();
            let nextArgs = args;

            // ---- 审计字段：所有表 ----
            if (operation === 'create') {
              nextArgs = {
                ...nextArgs,
                data: auditData(nextArgs.data, 'create', now, actor),
              };
            } else if (operation === 'update' || operation === 'updateMany') {
              nextArgs = {
                ...nextArgs,
                data: auditData(nextArgs.data, 'update', now, actor),
              };
            } else if (operation === 'createMany') {
              nextArgs = {
                ...nextArgs,
                data: auditCreateManyData(nextArgs.data, now, actor),
              };
            } else if (operation === 'upsert') {
              nextArgs = {
                ...nextArgs,
                create: auditData(nextArgs.create, 'create', now, actor),
                update: auditData(nextArgs.update, 'update', now, actor),
              };
            }

            // append-only：写操作里只放行 create / createMany，其余一律拒
            if (
              APPEND_ONLY_MODELS.has(model) &&
              APPEND_ONLY_FORBIDDEN.has(operation)
            ) {
              throw new Error(
                `禁止在 ${model} 上执行 ${operation}：` +
                  '该表是 append-only 的操作日志，只插不改不删（见 prisma.extension.ts）。',
              );
            }

            // 同步层：只有同步任务能写（runWithSyncWrite 包住的那条链）
            if (
              SYNC_OWNED_MODELS.has(model) &&
              SYNC_OWNED_FORBIDDEN.has(operation) &&
              !isSyncWriteScope()
            ) {
              throw new BusinessException(
                ErrorCode.SYNC_WRITE_FORBIDDEN,
                `禁止业务代码写入同步层的 ${model}：人与组织的真相在源系统，` +
                  '本系统的副本由同步任务维护。要改就去改源系统。' +
                  '同步任务自己的离场也不是 delete——它写 deletedAt / deletedBy 软删 ' +
                  '（需求 §2.1），硬删会被下面的 R24 守卫一并拒掉。',
                HttpStatus.FORBIDDEN,
              );
            }

            // 嵌套写：父查询里的子写入不触发本扩展，得自己顺着 args 钻
            if (NESTED_WRITE_CARRIERS.has(operation)) {
              assertNoNestedSyncWrite(model, args);
            }

            if (!options.softDelete || !SOFT_DELETE_MODELS.has(model)) {
              return query(nextArgs);
            }

            // ---- 软删除：只有四张实体表 ----
            if (operation === 'delete' || operation === 'deleteMany') {
              // R24（取代 R19）：扩展**不再**把 delete 改写成 update，改为直接拒绝。
              //
              // R19 时期靠 delegate 重派发一条 update，但 Prisma 6.19.3 的查询扩展
              // 回调只有 { model, operation, args, __internalParams, query }——没有
              // `client`（实测 raw.client === undefined），重派发只能打到闭包里的根
              // client 上：事务里调 `tx.sysPermission.delete()` 时，软删除的 update
              // 会**逃出事务**——外层回滚了，标记照样落库。「看起来原子、其实不原子」
              // 比不做事务更坏，test/permission.e2e-spec.ts 的回滚金丝雀钉的就是它。
              //
              // 所以「delete 改写成软删除」这层能力整个撤销：软删除写在 repository
              // 里，是一条**显式的** `update({ data: { deletedAt, deletedBy } })`，
              // 天然跑在调用方的事务里（如 DeptRepository.softDelete /
              // PermissionRepository.deleteWithRoleRefs，R24）；物理删除只走
              // includingDeleted（softDelete: false，purge 走的就是它）。
              // 这里把「不小心硬删了实体行」变成一次响亮的失败，而不是静默丢数据。
              throw new Error(
                `禁止在 ${model} 上直接 delete/deleteMany（R24）：` +
                  '实体表的“删除”是软删除，请改走 repository 的 softDelete' +
                  '（显式 update 打 deletedAt 标记）；物理删除只走 includingDeleted 的 purge。',
              );
            }

            if (READ_OPERATIONS.has(operation)) {
              return query(withNotDeleted(nextArgs));
            }

            // findUnique / findUniqueOrThrow 不在这里处理：ESLint 规则已禁止调用它们
            // （见 Task 7）。原因是 query() 无法换操作，运行时改写要在扩展里
            // 按模型名反射取 delegate 并切换 operation，绕且类型难收敛，
            // 而漏改的代价是「软删除的数据从个别接口漏出来」这类最难定位的 bug。
            //
            // `updateMany` 的 where 装得下过滤条件（`update` 单数装不下，见下），
            // 软删除行不该被批量写波及——过滤加在**这里**，不指望每个调用点
            // 自己记得带条件（Task 13 的提交资格门是全仓第一处 updateMany）。
            if (operation === 'updateMany') {
              return query(withNotDeleted(nextArgs));
            }

            // `update` 单数不在这里加 `deletedAt: null`——**这是刻意的，不是漏写**。
            // 它的 where 在 Prisma 里只能放唯一字段，塞不进过滤条件（与上面
            // findUnique 被禁是同一个物理原因）。改到软删除行的风险由调用侧兜住：
            // 每条写路径前面都有一道经过滤的读（`findById` / `assertExists`），
            // 已删除的行在那里就查不到，直接抛 404。
            return query(nextArgs);
          },
        },
      },
    }),
  );
}
