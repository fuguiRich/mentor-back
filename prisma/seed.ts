import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { hashSync } from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { BCRYPT_ROUNDS } from '../src/common/constants/auth.constants';

// seed 跑在没有请求上下文的进程里，审计字段取不到「当前操作者」，
// 一律写 0（系统标识）。`dotenv` 要显式调一次：Prisma 自己只读 DATABASE_URL，
// SEED_* 这几个是种子自己的配置。
config();

const SYSTEM_USER_ID = 0n;

const prisma = new PrismaClient();

/**
 * 种子不替调用方决定行业用词。
 *
 * 「总部」是企业口径，学校里对应的是「学院 / 处室」——把前者硬编码进种子，
 * 每个 fork 出去的项目第一件事都是来改这一行，而且改错时没有任何东西会说话
 * （库里就叫「总部」，接口照样 200）。四个种子值全部走环境变量，只给默认值。
 */
const ROOT_DEPT_NAME = process.env.SEED_ROOT_DEPT_NAME ?? '总部';
const ADMIN_USERNAME = process.env.SEED_ADMIN_USERNAME ?? 'admin';
const ADMIN_REAL_NAME = process.env.SEED_ADMIN_REAL_NAME ?? '超级管理员';

/**
 * 四个基础角色（Ruling 29）。同步侧建号时按 personType 绑角色，
 * 这四个不在库里，同步建号就全记 `role_missing`。
 *
 * dataScope 的取值是 data-scope 那套：all / deptAndChildren / dept / self。
 */
const SEED_ROLES = [
  { code: 'student', name: '学生', dataScope: 'self' },
  // 教师是身份；导师是审核通过后才获得的能力角色
  { code: 'teacher', name: '教师', dataScope: 'self' },
  { code: 'mentor', name: '导师', dataScope: 'self' },
  {
    code: 'college_admin',
    name: '二级学院管理员',
    dataScope: 'deptAndChildren',
  },
  { code: 'sc_admin', name: '创新创业学院管理员', dataScope: 'all' },
  // 内置超管角色：与 SysUser.isSuperAdmin 同步，删除 / 改 code / 停用会被 22103 拒绝
  { code: 'super_admin', name: '超级管理员', dataScope: 'all' },
] as const;

/**
 * P1 的八个权限点——`@RequirePermission` 在 `mentor` / `mentor-application` /
 * `mentor-material` 三个控制器里的**全部取值**，一个不多一个不少。
 *
 * 类型统一 `BUTTON`：它们对应的是接口，不是前端菜单页。`DIR` / `MENU` 是给前端
 * 菜单树用的，本计划不做前端，建 `MENU` 只会在权限树上挂一堆空节点。
 *
 * **为什么要落 seed**：不播权限点，`mentor:admin-update` / `review-sc` 这些接口
 * 上线即废——没有任何角色拿得到码，请求全是 403。各 e2e 自建权限行是**测试手法**，
 * 不是部署方案。
 */
const SEED_PERMISSIONS = [
  { code: 'mentor:profile', name: '查看本人导师档案' },
  { code: 'mentor:profile-update', name: '维护本人导师档案' },
  { code: 'mentor-application:submit', name: '提交入驻 / 信息修改申请' },
  { code: 'mentor-application:withdraw', name: '撤回本人申请' },
  { code: 'mentor-application:list', name: '查看入驻申请与佐证材料' },
  { code: 'mentor-application:review-college', name: '二级学院审核' },
  { code: 'mentor-application:review-sc', name: '双创学院审核' },
  { code: 'mentor:admin-update', name: '后台修改导师档案' },
  // Task 21 的时段管理：四条路由（GET/POST/PUT/DELETE /mentor/slots）全挂这个码。
  // 本任务就种，不等 Task 31——不种的话接口上线即废（403），手工测试也过不去。
  { code: 'mentor:slot-manage', name: '管理本人可指导时段' },
  // Task 22 的导师检索：两条路由（GET /mentors、GET /mentors/:id）挂这个码，
  // 学生 / 导师 / 两类管理员都要能查（计划 §Task 22：四个角色全绑）。
  { code: 'mentor:search', name: '检索导师' },
  // 管理员新建站内消息（P5 §4.5）：POST /messages。
  { code: 'message:send', name: '发送站内消息' },
  // Task 23 的发起预约：`POST /appointments` 挂这个码。学生要能发起，
  // 本任务就种，不等 Task 31——不种的话接口上线即废（403）。
  { code: 'appointment:create', name: '发起预约' },
  // Task 24 的预约处理：`POST /appointments/:id/{confirm,reject,reschedule}`
  // 三条路由全挂这个码，绑给导师。本任务就种，不等 Task 31。
  { code: 'appointment:handle', name: '处理预约' },
  // Task 26 的读取指导记录：`GET /appointments/:id/record` 挂这个码。可见性
  // 由服务内断言（申请人 / 导师 / 覆盖申请人部门的管理员），四个角色都要有码
  // 才进得去 service——本任务就种，不等 Task 31。
  { code: 'appointment:list', name: '查看预约与指导记录' },
  // Task 28 的异议复核：`POST /appointments/:id/adjudicate` 挂这个码。需求 §4.3
  // 把它放在「二级学院管理员 & 创新创业学院管理员**共有**需求」里，两个层级都
  // 绑（谁真能审由数据范围决定：申请人所在学院）。本任务就种，不等 Task 31
  // ——不种的话接口上线即废（403）。
  { code: 'appointment:adjudicate', name: '异议复核' },
  // P3 Task 34 的评价。`review:create` **只给 student**：评价是学生的主观判断，
  // 给管理员就等于允许代写，「学生评价」会变成「学院评价」。`review:list` 四个角色
  // 全给——学生看导师评分是检索的刚需，导师看自己的评价是改进依据，管理员看是考核输入。
  { code: 'review:create', name: '提交学生评价' },
  { code: 'review:list', name: '查看学生评价' },
  // P3 Task 36 的双创成果。登记只能导师本人（管理员代登记会让 §5.2 的初评
  // 「依据本院双创成果」变成自己给自己造证据）；列表给两个管理员层级看。
  { code: 'achievement:manage', name: '登记与维护本人双创成果' },
  { code: 'achievement:list', name: '查看双创成果' },
  // P3 Task 37–42 的考核。四个码切得很细，因为四个动作的**人**不同：
  // 开考核与初评是二级学院，终评是双创学院，申诉是导师，处理申诉是双创学院。
  { code: 'assessment:list', name: '查看考核' },
  { code: 'assessment:evaluate', name: '开考核与提交初评' },
  { code: 'assessment:finalize', name: '考核终评' },
  { code: 'assessment:appeal', name: '对考核结果申诉' },
  { code: 'assessment:appeal-handle', name: '处理考核申诉' },
  // P4 的统计。四个 `stats:*` 码按报表分域切；`stats:guidance` 也绑给学生
  // （§2.6 的个人档案导出复用同一个码，范围靠 `self` 收窄）。
  { code: 'stats:mentor', name: '导师资源库统计' },
  { code: 'stats:appointment', name: '师生预约情况统计' },
  { code: 'stats:guidance', name: '指导工作统计' },
  { code: 'stats:assessment', name: '考核等级分布统计' },
  // P4 的归档（§4.7 / §6.5）。`archive:list` 给导师 / 两个管理员层级；
  // `archive:manage` **只给双创学院**——「统一管理归档」是校级职责。
  { code: 'archive:list', name: '查看归档' },
  { code: 'archive:manage', name: '管理与清理归档' },
  // P5 §6.6：考核评分规则与系统参数配置。参数配置是校级职责，只给双创学院。
  { code: 'assessment:rule-manage', name: '配置考核评分规则' },
  { code: 'config:list', name: '查看系统参数' },
  { code: 'config:create', name: '新增系统参数' },
  { code: 'config:update', name: '修改系统参数' },
  { code: 'config:delete', name: '删除系统参数' },
  // P5 §4.5：消息 / 工作进度 / 提醒。消息是个人资源（四角色都能看自己的）；
  // 工作进度与发提醒是管理员视角。
  { code: 'message:list', name: '查看我的消息' },
  { code: 'work:progress', name: '查看导师工作进度' },
  { code: 'reminder:send', name: '发送站内提醒' },
  // P5 §5.4：学生成果关联。学院登记 / 关联；导师与学生只读。
  { code: 'student-achievement:manage', name: '登记与关联学生成果' },
  { code: 'student-achievement:list', name: '查看学生成果' },
  // 导师传佐证材料要先 `POST /files`，那条路由的码是 `file:create`（通用文件模块的）。
  // 不绑这个码，材料功能对导师就是死的——申请挂得上、文件传不上去。
  { code: 'file:create', name: '上传文件' },
  // 文件列表 / 预览 / 下载共用这个码。**它没有按归属过滤**，所以只给管理员
  // （§4.4 的下载预览）；学生 / 导师只上传，不拿列表权限。
  { code: 'file:list', name: '查看与下载文件' },
  // 手动触发 SSO 同步。只种码不绑角色：超管绕过权限检查，
  // 其他账号要手动同步时由超管按需授权。
  { code: 'sync:run', name: '手动触发同步' },
  { code: 'sync:manage', name: '管理同步定时任务' },
] as const;

/**
 * 角色 → 权限点。**只绑这些，不多给**。
 *
 * - `mentor`：自助那一组。`list` 也要给——读路由的可见性断言放行「申请人本人」，
 *   但没有权限码就连 service 都进不去。
 * - `college_admin`：只能审二级学院那一跳，**不给 `review-sc`**——给了的话
 *   「二级学院越权审双创」那条 403（Task 19 的 N2）永远触发不了。
 * - `sc_admin`：审双创那一跳 + 后台改字段（计划原文：「仅双创学院管理员可用」）。
 * - `student`：检索（Task 22）+ 发起预约（Task 23）+ 读指导记录（Task 26）
 *   ——学生不是导师，也不审核。
 */
const SEED_ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  // 教师：能提交入驻申请、维护本人档案、检索导师；审核通过后再叠加 mentor 角色
  teacher: [
    'mentor:profile',
    'mentor:profile-update',
    'mentor-application:submit',
    'mentor-application:withdraw',
    'mentor-application:list',
    'mentor:search',
    'message:list',
    'file:create',
  ],
  mentor: [
    'mentor:profile',
    'mentor:profile-update',
    'mentor-application:submit',
    'mentor-application:withdraw',
    'mentor-application:list',
    'mentor:slot-manage',
    'mentor:search',
    'appointment:handle',
    'appointment:list',
    'file:create',
    // P3：导师能看自己收到的评价（写评价是学生的事）
    'review:list',
    // P3：导师登记 / 维护自己的双创成果
    'achievement:manage',
    'achievement:list',
    // P3：导师看自己的考核结果，并对结果申诉
    'assessment:list',
    'assessment:appeal',
    // P4：导师看自己的指导工作台账（§3.7），范围靠 `self` 收窄
    'stats:guidance',
    // P4：导师只看自己的归档（范围同样靠 `self` 收窄）
    'archive:list',
    // P5：导师收自己的消息、看关联到自己的学生成果
    'message:list',
    'student-achievement:list',
  ],
  college_admin: [
    'mentor-application:list',
    'mentor-application:review-college',
    'mentor:search',
    'appointment:list',
    // Task 28：复核本院的异议单（`POST /appointments/:id/adjudicate`）
    'appointment:adjudicate',
    // P3：学院看本院导师的评价（考核初评的输入）
    'review:list',
    // P3：学院看本院导师的双创成果（§5.2 初评的依据）
    'achievement:list',
    // P3：学院开考核并提交初评（§5.2）。**不给 finalize**——终评是双创学院的事
    'assessment:list',
    'assessment:evaluate',
    // P4：学院看本院的导师资源库统计
    'stats:mentor',
    'stats:appointment',
    'stats:guidance',
    'stats:assessment',
    // P4：学院按归档时快照的部门看本院归档
    'archive:list',
    // P5：学院看本院工作进度、发提醒、登记与关联本院学生成果
    'message:list',
    'message:send',
    'work:progress',
    'reminder:send',
    'student-achievement:manage',
    'student-achievement:list',
    // §4.4：下载 / 预览学生与导师上传的佐证材料；登记学生成果需要上传佐证
    'file:create',
    'file:list',
  ],
  sc_admin: [
    'mentor-application:list',
    'mentor-application:review-sc',
    'mentor:admin-update',
    'mentor:search',
    'appointment:list',
    // Task 28：需求 §4.3 的复核申请是二级学院 / 双创学院管理员**共有**需求；
    // sc_admin 的数据范围是 all（clamp 到 dept 后仍覆盖全部学院），故一并绑码
    'appointment:adjudicate',
    // P3：双创学院看全校评价（考核终评的输入）
    'review:list',
    // P3：双创学院看全校成果（§6.2 终评结合全校指导成果）
    'achievement:list',
    // P3：双创学院看全校考核、终评、处理申诉（§6.2）。**不给 evaluate**——
    // 初评是二级学院的事，给了会让「退回重评」变成双创学院自己评自己
    'assessment:list',
    'assessment:finalize',
    'assessment:appeal-handle',
    // P4：双创学院看全校统计（可按学院下钻）
    'stats:mentor',
    'stats:appointment',
    'stats:guidance',
    'stats:assessment',
    // P4：§6.5「统一管理归档」——列表 + 手工归档 / 修改 / 取消 / 清理
    'archive:list',
    'archive:manage',
    // P5 §6.6：考核评分规则 + 系统参数配置
    'assessment:rule-manage',
    'config:list',
    'config:create',
    'config:update',
    'config:delete',
    'sync:run',
    'sync:manage',
    // P5 §4.5 / §5.4：全校工作进度、发提醒、看全校学生成果
    'message:list',
    'message:send',
    'work:progress',
    'reminder:send',
    'student-achievement:list',
    // §4.4：下载 / 预览学生与导师上传的佐证材料；登记学生成果需要上传佐证
    'file:create',
    'file:list',
  ],
  student: [
    'mentor:search',
    'appointment:create',
    'appointment:list',
    // P3：只有学生能写评价
    'review:create',
    'review:list',
    // P4：§2.6 的个人指导档案导出复用这个码，范围靠 `self` 收窄
    'stats:guidance',
    // P5：学生收自己的消息、看自己的学生成果（实践学时档案数据源）
    'message:list',
    'student-achievement:list',
    // §2.3：上传预约辅助材料前先 `POST /files`
    'file:create',
  ],
};

/**
 * 系统核心参数的默认值（§6.6）。
 *
 * **只补缺的，不覆盖已存在的值**：管理员调过的参数不能被重跑 seed 冲回默认。
 * `valueType` 一律 `number`（权重是小数，`parseNumberValue` 接受）。
 */
const SEED_CONFIGS = [
  {
    code: 'appointment.pending_ttl_hours',
    name: '预约待确认超时（小时）',
    value: '72',
  },
  {
    code: 'appointment.confirmed_grace_hours',
    name: '已确认预约宽限期（小时）',
    value: '24',
  },
  {
    code: 'appointment.review_ttl_days',
    name: '评价窗口（天）',
    value: '30',
  },
  {
    code: 'assessment.weight.review',
    name: '考核权重：学生评价',
    value: '0.4',
  },
  {
    code: 'assessment.weight.workload',
    name: '考核权重：指导工作量',
    value: '0.4',
  },
  {
    code: 'assessment.weight.achievement',
    name: '考核权重：双创成果',
    value: '0.2',
  },
  {
    code: 'assessment.workload_target_count',
    name: '考核工作量目标次数',
    value: '10',
  },
  {
    code: 'assessment.achievement_target_count',
    name: '考核成果目标数',
    value: '5',
  },
  {
    code: 'stats.failed_pair_threshold',
    name: '失败预约对阈值',
    value: '3',
  },
  { code: 'export.max_rows', name: '导出上限行数', value: '50000' },
  {
    code: 'archive.noncore_retention_days',
    name: '非核心归档保留天数',
    value: '1825',
  },
  { code: 'archive.purge_enabled', name: '归档过期清理开关', value: '0' },
] as const;

/**
 * 播系统核心参数，只建**缺的**。
 *
 * 幂等写法同 `seedPermissions`：按 code find-then-write，不用 upsert。
 * 软删的同 code 行不算数（DB-11 生成列唯一键允许重建）。
 */
async function seedConfigs(): Promise<void> {
  for (const spec of SEED_CONFIGS) {
    const existing = await prisma.sysConfig.findFirst({
      where: { code: spec.code, deletedAt: null },
    });
    if (existing !== null) {
      continue;
    }
    await prisma.sysConfig.create({
      data: {
        code: spec.code,
        name: spec.name,
        value: spec.value,
        valueType: 'number',
        status: 1,
        createdBy: SYSTEM_USER_ID,
        updatedBy: SYSTEM_USER_ID,
      },
    });
    console.log(`系统参数（补建）：${spec.code} = ${spec.value}`);
  }
}

/**
 * 播四个基础角色，只建**缺的**。
 *
 * 幂等写法是 find-then-write，**不是 upsert / connectOrCreate**：`sys_role` 的
 * 自然键是 `uk_sys_role_code_active`（DB-11 生成列唯一键），Prisma 的 upsert
 * 匹配的是主键 id，对不上它。也**不覆盖**已存在角色的 dataScope——管理员可能
 * 手工调过，重跑 seed 把它冲回默认值是最坏的一种静默改数据。
 *
 * 必须放在「seed 已执行过，跳过」那道守卫**之前**：已播过根部门 + admin 的
 * 老库也要能补上这四个角色，否则老库永远 role_missing。
 *
 * 权限点与角色绑定见 `seedPermissions`（P1 收口时补上，原先那句「本任务不播权限点」
 * 已作废——不播的话相关接口上线即废）。
 */
async function seedRoles(): Promise<void> {
  for (const spec of SEED_ROLES) {
    // deletedAt: null 不能省：软删的同 code 行仍占着表，按 DB-11 它不算数，
    // 重跑 seed 应当把「缺的那个」建回来。
    const existing = await prisma.sysRole.findFirst({
      where: { code: spec.code, deletedAt: null },
    });
    if (existing !== null) {
      continue;
    }

    await prisma.sysRole.create({
      data: {
        code: spec.code,
        name: spec.name,
        dataScope: spec.dataScope,
        status: 1,
        remark: '由 seed 创建',
        createdBy: SYSTEM_USER_ID,
        updatedBy: SYSTEM_USER_ID,
      },
    });
    console.log(`基础角色（补建）：${spec.code} / ${spec.name}`);
  }
}

/**
 * 播 P1 的八个权限点，并把它们绑到对应角色，**只建缺的**。
 *
 * 幂等：权限点按 `code` 找未删行，绑定按 `(roleId, permissionId)` 找，两者都是
 * find-then-write 而**不是 upsert**——理由同 `seedRoles`：`sys_permission` 的自然键
 * 是 code（软删行仍占着表），Prisma 的 upsert 认的是主键，对不上。
 *
 * **只加不删**：管理员手工加的绑定不会被这里冲掉；反过来，从
 * `SEED_ROLE_PERMISSIONS` 里删掉一条也**不会**回收库里已有的旧绑定——回收权限
 * 是危险操作，交给后台的权限管理，不交给重跑 seed。
 *
 * 必须放在「seed 已执行过，跳过」那道守卫**之前**，理由同 `seedRoles`。
 */
async function seedPermissions(): Promise<void> {
  const permissionIds = new Map<string, bigint>();

  for (const spec of SEED_PERMISSIONS) {
    const existing = await prisma.sysPermission.findFirst({
      where: { code: spec.code, deletedAt: null },
    });
    if (existing !== null) {
      permissionIds.set(spec.code, existing.id);
      continue;
    }

    const created = await prisma.sysPermission.create({
      data: {
        type: 'BUTTON',
        code: spec.code,
        name: spec.name,
        sortOrder: 0,
        status: 1,
        createdBy: SYSTEM_USER_ID,
        updatedBy: SYSTEM_USER_ID,
      },
    });
    permissionIds.set(spec.code, created.id);
    console.log(`权限点（补建）：${spec.code} / ${spec.name}`);
  }

  for (const [roleCode, codes] of Object.entries(SEED_ROLE_PERMISSIONS)) {
    const role = await prisma.sysRole.findFirst({
      where: { code: roleCode, deletedAt: null },
    });
    if (role === null) {
      // seedRoles 先跑，正常到不了这里；到了说明角色被软删过——
      // 别把权限静默绑到一个不存在的角色上
      console.log(`跳过权限绑定：角色 ${roleCode} 不存在`);
      continue;
    }

    for (const code of codes) {
      const permissionId = permissionIds.get(code);
      if (permissionId === undefined) {
        continue;
      }

      // findFirst 而不是 findUnique：本仓的 lint 禁止软删表用 findUnique
      // （它只接受唯一键条件，追不了 deletedAt 过滤）。这里用复合键的两个字段
      // 做 where，语义与 findUnique 等价，且与全仓写法一致。
      const bound = await prisma.sysRolePermission.findFirst({
        where: { roleId: role.id, permissionId },
      });
      if (bound !== null) {
        continue;
      }

      await prisma.sysRolePermission.create({
        data: {
          roleId: role.id,
          permissionId,
          createdBy: SYSTEM_USER_ID,
          updatedBy: SYSTEM_USER_ID,
        },
      });
      console.log(`权限绑定（补建）：${roleCode} ← ${code}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 演示数据（默认**不生成**）
// ---------------------------------------------------------------------------

/**
 * 是否生成演示数据。**默认关闭**，要显式 `SEED_DEMO_DATA=1`。
 *
 * 这些账号的密码是一个**公开常量**：默认生成，就等于在每个环境里放一批
 * 可直接登录的后门。生产库上误跑一次 seed 的代价，远大于本地多敲一个环境变量。
 */
const DEMO_DATA_ENABLED =
  process.env.SEED_DEMO_DATA === '1' || process.env.SEED_DEMO_DATA === 'true';

/**
 * 手动测试前把演示账号恢复到已知状态：密码、状态、人员类型、角色都按
 * `DEMO_PEOPLE` / `DEMO_ADMINS` 重置（不碰导师档案等业务数据）。
 */
const RESET_DEMO_ACCOUNTS =
  process.env.SEED_RESET_DEMO_PASSWORDS === '1' ||
  process.env.SEED_RESET_DEMO_PASSWORDS === 'true';

const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'Mentor@2026';

interface DemoOrgSpec {
  code: string;
  name: string;
  parentCode: string | null;
  kind: string;
}

/**
 * 演示组织树：一个根 + 两个学院 + 一个系。
 *
 * 两个学院是**故意的**——只有一个学院，数据范围的「本院可见 / 外院 403」
 * 就永远测不出来。软件工程系挂在计算机学院下面，用来测 `deptAndChildren`。
 *
 * 行业用词在这里不算 fork 成本：这段只在 `SEED_DEMO_DATA=1` 时跑，本就是假数据，
 * 要改就改这个数组。
 */
const DEMO_ORGS: readonly DemoOrgSpec[] = [
  { code: 'HQ', name: ROOT_DEPT_NAME, parentCode: null, kind: 'root' },
  { code: 'CS', name: '计算机学院', parentCode: 'HQ', kind: 'college' },
  { code: 'CS-SE', name: '软件工程系', parentCode: 'CS', kind: 'department' },
  { code: 'FL', name: '外国语学院', parentCode: 'HQ', kind: 'college' },
];

interface DemoPersonSpec {
  login: string;
  realName: string;
  personType: 'internalMentor' | 'externalMentor' | 'teacher' | 'student';
  orgCode: string;
  roles: readonly string[];
}

/**
 * 同步源里会有的人：三个导师（两个内校、一个外校）+ 一个尚未入驻的教师
 * + 两个学生。
 *
 * `T002` 是外校导师——`affiliateOrg` / `socialRoles` 只有外校能填（R49），
 * 没有外校样本，那两个字段的正常路径就测不到。
 * `T003` 在外国语学院——外院的人，用来测数据范围的负断言。
 * `T004` 是**只有 teacher 角色、没有导师档案**的教师：用来走
 * 「建档 → 提交入驻申请 → 审核通过后加 mentor 角色」的完整链路。
 * 两个学生是**故意的**：预约、评价、成果里凡是有「本人 / 他人」区分的断言，
 * 只有一个学生就只能测到正路径；`20230002` 用来测「别人的预约看不到」。
 */
const DEMO_PEOPLE: readonly DemoPersonSpec[] = [
  {
    login: 'T001',
    realName: '张明远',
    personType: 'internalMentor',
    orgCode: 'CS',
    roles: ['mentor'],
  },
  {
    login: 'T002',
    realName: '李思齐',
    personType: 'externalMentor',
    orgCode: 'CS',
    roles: ['mentor'],
  },
  {
    login: 'T003',
    realName: '王海燕',
    personType: 'internalMentor',
    orgCode: 'FL',
    roles: ['mentor'],
  },
  {
    login: 'T004',
    realName: '周文博',
    personType: 'teacher',
    orgCode: 'CS',
    roles: ['teacher'],
  },
  {
    login: '20230001',
    realName: '陈一鸣',
    personType: 'student',
    orgCode: 'CS-SE',
    roles: ['student'],
  },
  {
    login: '20230002',
    realName: '赵晓雨',
    personType: 'student',
    orgCode: 'CS-SE',
    roles: ['student'],
  },
];

/**
 * 管理员**不在同步源里**（R4：超管建号 + 绑角色），所以只有 `SysUser`、
 * 没有对应的 `SyncPerson`。
 *
 * 两个二级学院管理员是故意的：拿计算机学院的管理员去审外国语学院的申请，
 * 必须 403——只有一个管理员，这条负断言测不出来。
 */
const DEMO_ADMINS: readonly DemoPersonSpec[] = [
  {
    login: 'cs_admin',
    realName: '计算机学院管理员',
    personType: 'internalMentor',
    orgCode: 'CS',
    roles: ['college_admin'],
  },
  {
    login: 'fl_admin',
    realName: '外国语学院管理员',
    personType: 'internalMentor',
    orgCode: 'FL',
    roles: ['college_admin'],
  },
  {
    login: 'sc_admin',
    realName: '创新创业学院管理员',
    personType: 'internalMentor',
    orgCode: 'HQ',
    roles: ['sc_admin'],
  },
];

interface DemoProfileSpec {
  login: string;
  /** 职称 / 资质（R28）。Task 22 的「按职称资质筛选」靠它才有可筛的东西 */
  professionalTitle: string;
  researchFields: readonly string[];
  summary: string;
  researchAchievements?: string;
  guidanceExperience?: string;
  affiliateOrg?: string;
  socialRoles?: string;
}

/**
 * 三份已生效的导师档案：内校 T001、外校 T002、外院内校 T003。
 *
 * 三个职称各不相同（教授 / 高级工程师 / 副教授），Task 22 的
 * `professionalTitle` 筛选才能演示出「命中一位」；T002 是外校，顺带把
 * `affiliateOrg` / `socialRoles` 的非空路径带出来（R49）。
 */
const DEMO_PROFILES: readonly DemoProfileSpec[] = [
  {
    login: 'T001',
    professionalTitle: '教授',
    researchFields: ['软件工程', '人工智能'],
    summary: '长期从事软件工程与人工智能方向的教学与科研工作。',
    researchAchievements: '主持省部级项目 2 项，发表论文 10 余篇。',
    guidanceExperience: '指导研究生 12 名，其中 3 名获校级优秀论文。',
  },
  {
    login: 'T002',
    professionalTitle: '高级工程师',
    researchFields: ['大数据', '企业实践'],
    summary: '企业一线的大数据平台建设与工程实践指导。',
    researchAchievements: '完成横向课题 3 项，授权发明专利 2 项。',
    guidanceExperience: '企业导师 5 年，联合指导毕业设计 8 组。',
    affiliateOrg: '某某研究院',
    socialRoles: '某某学会理事',
  },
  {
    login: 'T003',
    professionalTitle: '副教授',
    researchFields: ['外国语言学', '跨文化研究'],
    summary: '外语教学与跨文化交际研究。',
    guidanceExperience: '指导学科竞赛获省级奖项 4 项。',
  },
];

/** 只建缺的：同名同父的部门已存在就复用 */
async function ensureDept(
  name: string,
  parentId: bigint | null,
  sortOrder: number,
): Promise<bigint> {
  const existing = await prisma.sysDept.findFirst({
    where: { name, parentId, deletedAt: null },
  });
  if (existing !== null) {
    return existing.id;
  }
  const created = await prisma.sysDept.create({
    data: {
      parentId,
      name,
      sortOrder,
      status: 1,
      remark: '演示数据',
      createdBy: SYSTEM_USER_ID,
      updatedBy: SYSTEM_USER_ID,
    },
  });
  return created.id;
}

/** 只建缺的：账号按 `username` 找，角色绑定按 `(userId, roleId)` 找 */
async function ensureDemoUser(
  spec: DemoPersonSpec,
  deptId: bigint,
  roleIds: ReadonlyMap<string, bigint>,
): Promise<void> {
  const existing = await prisma.sysUser.findFirst({
    where: { username: spec.login, deletedAt: null },
  });
  const user =
    existing ??
    (await prisma.sysUser.create({
      data: {
        username: spec.login,
        password: hashSync(DEMO_PASSWORD, BCRYPT_ROUNDS),
        realName: spec.realName,
        employeeNo: spec.login,
        deptId,
        status: 1,
        isSuperAdmin: false,
        // 外校导师不在 SSO 里，保持本地账号；其余演示人员按 SSO 账号处理
        authSource: spec.personType === 'externalMentor' ? 'local' : 'sso',
        createdBy: SYSTEM_USER_ID,
        updatedBy: SYSTEM_USER_ID,
      },
    }));

  for (const code of spec.roles) {
    const roleId = roleIds.get(code);
    if (roleId === undefined) {
      continue;
    }
    const bound = await prisma.sysUserRole.findFirst({
      where: { userId: user.id, roleId },
    });
    if (bound !== null) {
      continue;
    }
    await prisma.sysUserRole.create({
      data: {
        userId: user.id,
        roleId,
        createdBy: SYSTEM_USER_ID,
        updatedBy: SYSTEM_USER_ID,
      },
    });
  }
}

/**
 * 手动测试前重置演示账号：密码、状态、姓名、部门、人员类型、角色全部回到
 * `DEMO_PEOPLE` / `DEMO_ADMINS` 的规格。只动账号与同步人员行，不动导师档案、
 * 预约、成果等业务数据。
 */
async function resetDemoAccounts(
  orgs: ReadonlyMap<string, { unitId: bigint; deptId: bigint }>,
  roleIds: ReadonlyMap<string, bigint>,
): Promise<void> {
  if (!RESET_DEMO_ACCOUNTS) {
    return;
  }

  const applyRoles = async (
    userId: bigint,
    desiredCodes: readonly string[],
  ): Promise<void> => {
    const desired = desiredCodes
      .map((code) => roleIds.get(code))
      .filter((id): id is bigint => id !== undefined);
    await prisma.sysUserRole.deleteMany({
      where: { userId, roleId: { notIn: desired } },
    });
    const current = await prisma.sysUserRole.findMany({
      where: { userId },
      select: { roleId: true },
    });
    for (const roleId of desired) {
      if (!current.some((row) => row.roleId === roleId)) {
        await prisma.sysUserRole.create({
          data: {
            userId,
            roleId,
            createdBy: SYSTEM_USER_ID,
            updatedBy: SYSTEM_USER_ID,
          },
        });
      }
    }
  };

  for (const spec of DEMO_PEOPLE) {
    const org = orgs.get(spec.orgCode);
    if (org === undefined) {
      continue;
    }
    const user = await prisma.sysUser.findFirst({
      where: { username: spec.login, deletedAt: null },
    });
    if (user === null) {
      continue;
    }
    await prisma.sysUser.update({
      where: { id: user.id },
      data: {
        password: hashSync(DEMO_PASSWORD, BCRYPT_ROUNDS),
        realName: spec.realName,
        deptId: org.deptId,
        status: 1,
        authSource: spec.personType === 'externalMentor' ? 'local' : 'sso',
      },
    });
    const person = await prisma.syncPerson.findFirst({
      where: { login: spec.login, deletedAt: null },
    });
    if (person !== null) {
      await prisma.syncPerson.update({
        where: { id: person.id },
        data: {
          realName: spec.realName,
          personType: spec.personType,
          orgUnitId: org.unitId,
        },
      });
    }
    await applyRoles(user.id, spec.roles);
  }

  for (const spec of DEMO_ADMINS) {
    const org = orgs.get(spec.orgCode);
    if (org === undefined) {
      continue;
    }
    const user = await prisma.sysUser.findFirst({
      where: { username: spec.login, deletedAt: null },
    });
    if (user === null) {
      continue;
    }
    await prisma.sysUser.update({
      where: { id: user.id },
      data: {
        password: hashSync(DEMO_PASSWORD, BCRYPT_ROUNDS),
        realName: spec.realName,
        deptId: org.deptId,
        status: 1,
        authSource: 'local',
      },
    });
    await applyRoles(user.id, spec.roles);
  }

  console.log(
    `演示账号已重置：${[...DEMO_PEOPLE, ...DEMO_ADMINS]
      .map((spec) => spec.login)
      .join(' / ')}（密码 ${DEMO_PASSWORD}）`,
  );
}

/**
 * 学生演示账号的**强制校正**。
 *
 * `ensureDemoUser` 对已存在的账号只补角色、不改密码 / 人员类型——这对普通
 * 演示数据是对的（不覆盖手工改动），但学号从 `S001` 改成数字后，老库里可能
 * 已经存在同名的非学生行（测试残留）。学生的身份、密码、角色必须收敛到
 * 演示规格，否则「能登录但角色不对 / 密码不对」。
 */
async function repairDemoStudent(
  spec: DemoPersonSpec,
  deptId: bigint,
  orgUnitId: bigint,
  roleIds: ReadonlyMap<string, bigint>,
): Promise<void> {
  const person = await prisma.syncPerson.findFirst({
    where: { login: spec.login },
  });
  if (person !== null) {
    await prisma.syncPerson.update({
      where: { id: person.id },
      data: {
        realName: spec.realName,
        personType: 'student',
        orgUnitId,
      },
    });
  }

  const user = await prisma.sysUser.findFirst({
    where: { username: spec.login },
  });
  if (user === null) {
    return;
  }
  await prisma.sysUser.update({
    where: { id: user.id },
    data: {
      password: hashSync(DEMO_PASSWORD, BCRYPT_ROUNDS),
      realName: spec.realName,
      deptId,
      status: 1,
      authSource: 'sso',
    },
  });

  const desiredRoleIds = new Set(
    spec.roles
      .map((code) => roleIds.get(code))
      .filter((id): id is bigint => id !== undefined),
  );
  const current = await prisma.sysUserRole.findMany({
    where: { userId: user.id },
  });
  for (const binding of current) {
    if (!desiredRoleIds.has(binding.roleId)) {
      await prisma.sysUserRole.delete({ where: { id: binding.id } });
    }
  }
  for (const roleId of desiredRoleIds) {
    if (!current.some((binding) => binding.roleId === roleId)) {
      await prisma.sysUserRole.create({
        data: {
          userId: user.id,
          roleId,
          createdBy: SYSTEM_USER_ID,
          updatedBy: SYSTEM_USER_ID,
        },
      });
    }
  }
}

/**
 * 生成演示数据：组织树 + 测试账号 + 一份已生效的导师档案。
 *
 * 幂等：全部按自然键 find-then-write（部门按「同名同父」、组织按 code、
 * 人员按 login、账号按 username、档案按 personId）。重复跑不产生重复行，
 * 也不覆盖已存在行上的任何字段——管理员手工改过的演示账号不会被冲回去。
 */
/**
 * 学号格式迁移：早期演示账号用的是 S001 / S002，不符合「学号 = 数字」
 * 的校验口径。这里把老账号原地改名，保留它已有的预约 / 评价 / 成果关系。
 *
 * 目标账号已存在时跳过（幂等），不覆盖任何已有行。
 */
const LEGACY_STUDENT_LOGIN_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ['S001', '20230001'],
  ['S002', '20230002'],
];

async function renameLegacyDemoStudents(): Promise<void> {
  for (const [from, to] of LEGACY_STUDENT_LOGIN_RENAMES) {
    const person = await prisma.syncPerson.findFirst({
      where: { login: from },
    });
    const targetPerson = await prisma.syncPerson.findFirst({
      where: { login: to },
    });
    if (person !== null && targetPerson === null) {
      await prisma.syncPerson.update({
        where: { id: person.id },
        data: { login: to },
      });
      console.log(`学生学号迁移：${from} → ${to}`);
    }

    const user = await prisma.sysUser.findFirst({ where: { username: from } });
    const targetUser = await prisma.sysUser.findFirst({
      where: { username: to },
    });
    if (user !== null && targetUser === null) {
      await prisma.sysUser.update({
        where: { id: user.id },
        data: { username: to, employeeNo: to },
      });
    }
  }
}

async function seedDemoData(rootDeptId: bigint): Promise<void> {
  if (!DEMO_DATA_ENABLED) {
    console.log(
      '演示数据未生成（设 SEED_DEMO_DATA=1 可生成学院 / 测试账号 / 一份已生效的导师档案）',
    );
    return;
  }

  await renameLegacyDemoStudents();

  // ---- 1. 组织树：SyncOrgUnit 与 SysDept 各一套，靠 `deptId` 投影连起来 ----
  const orgs = new Map<string, { unitId: bigint; deptId: bigint }>();

  for (const [index, spec] of DEMO_ORGS.entries()) {
    const parent =
      spec.parentCode === null ? undefined : orgs.get(spec.parentCode);
    if (spec.parentCode !== null && parent === undefined) {
      throw new Error(
        `演示组织 ${spec.code} 的父级 ${spec.parentCode} 尚未创建（数组顺序错了）`,
      );
    }

    // 根部门由 main 建好，这里复用；其余各自建一个
    const deptId =
      parent === undefined
        ? rootDeptId
        : await ensureDept(spec.name, parent.deptId, index);

    const existingUnit = await prisma.syncOrgUnit.findFirst({
      where: { code: spec.code, deletedAt: null },
    });
    const unit =
      existingUnit ??
      (await prisma.syncOrgUnit.create({
        data: {
          code: spec.code,
          name: spec.name,
          parentId: parent?.unitId ?? null,
          kind: spec.kind,
          syncedAt: new Date(),
          deptId,
          createdBy: SYSTEM_USER_ID,
          updatedBy: SYSTEM_USER_ID,
        },
      }));

    orgs.set(spec.code, { unitId: unit.id, deptId });
  }

  // ---- 2. 账号与角色 ----
  const roleIds = new Map<string, bigint>();
  for (const role of await prisma.sysRole.findMany({
    where: { deletedAt: null },
  })) {
    if (role.code !== null) {
      roleIds.set(role.code, role.id);
    }
  }

  // 同步源里的人：SyncPerson + SysUser（登录名 = login）
  for (const spec of DEMO_PEOPLE) {
    const org = orgs.get(spec.orgCode);
    if (org === undefined) {
      throw new Error(`演示人员 ${spec.login} 的学院 ${spec.orgCode} 不存在`);
    }

    const existingPerson = await prisma.syncPerson.findFirst({
      where: { login: spec.login, deletedAt: null },
    });
    if (existingPerson === null) {
      await prisma.syncPerson.create({
        data: {
          login: spec.login,
          realName: spec.realName,
          personType: spec.personType,
          orgUnitId: org.unitId,
          syncedAt: new Date(),
          createdBy: SYSTEM_USER_ID,
          updatedBy: SYSTEM_USER_ID,
        },
      });
    }

    await ensureDemoUser(spec, org.deptId, roleIds);
    if (spec.personType === 'student') {
      await repairDemoStudent(spec, org.deptId, org.unitId, roleIds);
    }
  }

  // 管理员不在同步源里：只有 SysUser
  for (const spec of DEMO_ADMINS) {
    const org = orgs.get(spec.orgCode);
    if (org === undefined) {
      throw new Error(`演示管理员 ${spec.login} 的学院 ${spec.orgCode} 不存在`);
    }
    await ensureDemoUser(spec, org.deptId, roleIds);
  }

  await resetDemoAccounts(orgs, roleIds);

  // ---- 3. 三份已生效的导师档案 ----
  // 没有它们，`PUT /mentor/profiles/:id`（后台改字段）、`profile-change` 与
  // Task 22 的「按职称资质 / 指导方向检索」都要先走完一整条入驻审核才测得到。
  // 三份的 `professionalTitle` 是**故意的**（Task 22 判据）：不补的话「按职称
  // 筛选」在演示数据上没有可筛的东西，手工测会以为功能坏了。
  for (const spec of DEMO_PROFILES) {
    const person = await prisma.syncPerson.findFirst({
      where: { login: spec.login, deletedAt: null },
    });
    if (person === null) {
      continue;
    }

    const existingProfile = await prisma.mentorProfile.findFirst({
      where: { personId: person.id, deletedAt: null },
    });
    if (existingProfile === null) {
      await prisma.mentorProfile.create({
        data: {
          personId: person.id,
          researchFields: [...spec.researchFields],
          // 直接落 2 是刻意的：这些只为让相关接口一登录就能测。
          // 状态机在业务代码里是唯一写口，seed 走的是没有扩展的裸 client。
          status: 2,
          summary: spec.summary,
          researchAchievements: spec.researchAchievements ?? null,
          guidanceExperience: spec.guidanceExperience ?? null,
          affiliateOrg: spec.affiliateOrg ?? null,
          socialRoles: spec.socialRoles ?? null,
          professionalTitle: spec.professionalTitle,
          createdBy: SYSTEM_USER_ID,
          updatedBy: SYSTEM_USER_ID,
        },
      });
      console.log(
        `导师档案（补建）：${spec.login} / status=2 APPROVED / ${spec.professionalTitle}`,
      );
      continue;
    }

    // 老库（Task 20c / 22 之前建的档案）没有职称：只补空值，**不覆盖**已填的
    // ——管理员手工改过的档案不该被重跑 seed 冲回去。
    if (existingProfile.professionalTitle === null) {
      await prisma.mentorProfile.update({
        where: { id: existingProfile.id },
        data: { professionalTitle: spec.professionalTitle },
      });
      console.log(
        `导师档案（补职称）：${spec.login} / ${spec.professionalTitle}`,
      );
    }
  }

  // ---- 3.5 归档演示（P4 Task 54）----
  // 一条核心（自动归档的形状）+ 一条非核心（手工归档的形状），
  // 让 §4.7 的检索与 §6.5 的清理两条路径都能手工试。
  // 目标 ID 用 `demo-*` 前缀：归档是弱关联，不要求目标行真的存在。
  const demoPerson = await prisma.syncPerson.findFirst({
    where: { login: 'T001', deletedAt: null },
  });
  const demoProfile =
    demoPerson === null
      ? null
      : await prisma.mentorProfile.findFirst({
          where: { personId: demoPerson.id, deletedAt: null },
        });
  if (demoProfile !== null) {
    const demos: Array<{
      targetType: string;
      targetId: string;
      title: string;
      category: string;
      core: number;
      retentionUntil: Date | null;
    }> = [
      {
        targetType: 'MentorApplication',
        targetId: `demo-onboard-${demoProfile.id}`,
        title: '演示：导师入驻审核归档',
        category: 'mentor-application',
        core: 1,
        retentionUntil: null,
      },
      {
        targetType: 'Achievement',
        targetId: `demo-achievement-${demoProfile.id}`,
        title: '演示：非核心成果归档',
        category: 'achievement',
        core: 0,
        retentionUntil: new Date(Date.now() + 1825 * 86_400_000),
      },
    ];
    for (const demo of demos) {
      const existing = await prisma.archiveItem.findFirst({
        where: {
          targetType: demo.targetType,
          targetId: demo.targetId,
          deletedAt: null,
        },
      });
      if (existing !== null) {
        continue;
      }
      await prisma.archiveItem.create({
        data: {
          ...demo,
          mentorId: demoProfile.id,
          deptId: orgs.get('CS')?.deptId ?? null,
          archivedAt: new Date(),
          summary:
            demo.core === 1
              ? null
              : '演示用非核心材料，可在归档列表里试检索与清理',
          createdBy: SYSTEM_USER_ID,
          updatedBy: SYSTEM_USER_ID,
        },
      });
      console.log(`归档（补建）：${demo.targetId} / core=${demo.core}`);
    }
  }

  // ---- 3.6 消息与学生成果关联演示（P5 Task 60）----
  // 让 §4.5 的消息列表与 §5.4 的「关联成果 → 考核 / 归档」两条路径
  // 在演示环境里各有一条现成数据可看。
  const demoStudent = await prisma.syncPerson.findFirst({
    where: { login: '20230001', deletedAt: null },
  });
  const demoMentorUser = await prisma.sysUser.findFirst({
    where: { username: 'T001', deletedAt: null },
  });
  if (demoProfile !== null && demoStudent !== null) {
    const existingStudentAchievement =
      await prisma.studentAchievement.findFirst({
        where: {
          studentPersonId: demoStudent.id,
          title: '演示：学生省级竞赛金奖',
          deletedAt: null,
        },
      });
    if (existingStudentAchievement === null) {
      const awardedAt = new Date();
      const achievement = await prisma.achievement.create({
        data: {
          mentorId: demoProfile.id,
          type: 1,
          title: '演示：学生省级竞赛金奖',
          level: 2,
          awardedAt,
          description: '学生双创成果关联',
          createdBy: SYSTEM_USER_ID,
          updatedBy: SYSTEM_USER_ID,
        },
      });
      const studentAchievement = await prisma.studentAchievement.create({
        data: {
          studentPersonId: demoStudent.id,
          mentorId: demoProfile.id,
          achievementId: achievement.id,
          deptId: orgs.get('CS')?.deptId ?? null,
          type: 1,
          title: '演示：学生省级竞赛金奖',
          level: 2,
          awardedAt,
          linkedAt: new Date(),
          linkedBy: SYSTEM_USER_ID,
          createdBy: SYSTEM_USER_ID,
          updatedBy: SYSTEM_USER_ID,
        },
      });
      await prisma.archiveItem.create({
        data: {
          targetType: 'StudentAchievement',
          targetId: studentAchievement.id.toString(),
          title: '演示：学生省级竞赛金奖',
          mentorId: demoProfile.id,
          deptId: orgs.get('CS')?.deptId ?? null,
          category: 'achievement',
          core: 0,
          archivedAt: new Date(),
          retentionUntil: new Date(Date.now() + 1825 * 86_400_000),
          summary: '演示用学生成果关联归档',
          createdBy: SYSTEM_USER_ID,
          updatedBy: SYSTEM_USER_ID,
        },
      });
      console.log(`学生成果（补建）：20230001 → T001 / 已关联`);
    }

    if (demoMentorUser !== null) {
      const existingMessage = await prisma.message.findFirst({
        where: {
          recipientUserId: demoMentorUser.id,
          type: 1,
          bizId: demoProfile.id.toString(),
          deletedAt: null,
        },
      });
      if (existingMessage === null) {
        await prisma.message.create({
          data: {
            recipientUserId: demoMentorUser.id,
            type: 1,
            title: '预约待处理提醒',
            content: '您有 1 条预约待确认，请及时处理。',
            bizType: 'MentorProfile',
            bizId: demoProfile.id.toString(),
            createdBy: SYSTEM_USER_ID,
            updatedBy: SYSTEM_USER_ID,
          },
        });
        console.log('消息（补建）：T001 / 预约待处理提醒');
      }
    }
  }

  // ---- 4. 把账号打出来，省得再去库里翻 ----
  const passwordNote =
    process.env.SEED_DEMO_PASSWORD === undefined
      ? `统一密码：${DEMO_PASSWORD}`
      : '密码取自 SEED_DEMO_PASSWORD';
  console.log('');
  console.log(`演示账号（${passwordNote}）：`);
  for (const spec of [...DEMO_PEOPLE, ...DEMO_ADMINS]) {
    console.log(
      `  ${spec.login.padEnd(9)} ${spec.realName.padEnd(8, '　')} ${spec.roles.join(',')}`,
    );
  }
}

/**
 * 教师角色回填：历史同步把教师绑成了 mentor；这里按「是否已有生效档案」拆开。
 * - 有已生效档案 → 补 teacher，保留/补 mentor；
 * - 没有 → 补 teacher，摘掉 mentor。
 * 只处理 personType='teacher'，不碰内外校导师与管理员。
 */
async function backfillTeacherRoles(): Promise<void> {
  const teacherRole = await prisma.sysRole.findFirst({
    where: { code: 'teacher', deletedAt: null },
  });
  const mentorRole = await prisma.sysRole.findFirst({
    where: { code: 'mentor', deletedAt: null },
  });
  if (teacherRole === null || mentorRole === null) {
    console.log('教师角色回填跳过：teacher / mentor 角色不存在');
    return;
  }

  const teachers = await prisma.syncPerson.findMany({
    where: { personType: 'teacher', deletedAt: null },
    select: { login: true },
  });

  let addedTeacher = 0;
  let addedMentor = 0;
  let removedMentor = 0;

  for (const { login } of teachers) {
    const user = await prisma.sysUser.findFirst({
      where: { username: login, deletedAt: null },
      select: { id: true },
    });
    if (user === null) continue;

    const approved = await prisma.mentorProfile.findFirst({
      where: { person: { login }, status: 2, deletedAt: null },
      select: { id: true },
    });

    const teacherBinding = await prisma.sysUserRole.findFirst({
      where: { userId: user.id, roleId: teacherRole.id },
    });
    if (teacherBinding === null) {
      await prisma.sysUserRole.create({
        data: {
          userId: user.id,
          roleId: teacherRole.id,
          createdBy: SYSTEM_USER_ID,
          updatedBy: SYSTEM_USER_ID,
        },
      });
      addedTeacher += 1;
    }

    if (approved !== null) {
      const mentorBinding = await prisma.sysUserRole.findFirst({
        where: { userId: user.id, roleId: mentorRole.id },
      });
      if (mentorBinding === null) {
        await prisma.sysUserRole.create({
          data: {
            userId: user.id,
            roleId: mentorRole.id,
            createdBy: SYSTEM_USER_ID,
            updatedBy: SYSTEM_USER_ID,
          },
        });
        addedMentor += 1;
      }
    } else {
      const removed = await prisma.sysUserRole.deleteMany({
        where: { userId: user.id, roleId: mentorRole.id },
      });
      removedMentor += removed.count;
    }
  }

  console.log(
    `教师角色回填：teacher +${addedTeacher}，mentor +${addedMentor}，mentor -${removedMentor}`,
  );
}

/**
 * 超管角色回填：`isSuperAdmin=true` 的用户必须持有 `super_admin` 角色；
 * 反之持有该角色的用户也必须置标志。两边任意一边缺都补上，保持双写一致。
 */
async function backfillSuperAdminRole(): Promise<void> {
  const role = await prisma.sysRole.findFirst({
    where: { code: 'super_admin', deletedAt: null },
  });
  if (role === null) {
    console.log('超管角色回填跳过：super_admin 角色不存在');
    return;
  }

  const admins = await prisma.sysUser.findMany({
    where: { isSuperAdmin: true, deletedAt: null },
    select: { id: true },
  });
  let bound = 0;
  for (const user of admins) {
    const existing = await prisma.sysUserRole.findFirst({
      where: { userId: user.id, roleId: role.id },
    });
    if (existing === null) {
      await prisma.sysUserRole.create({
        data: {
          userId: user.id,
          roleId: role.id,
          createdBy: SYSTEM_USER_ID,
          updatedBy: SYSTEM_USER_ID,
        },
      });
      bound += 1;
    }
  }

  const holders = await prisma.sysUserRole.findMany({
    where: { roleId: role.id },
    select: { userId: true },
  });
  let flagged = 0;
  for (const holder of holders) {
    const user = await prisma.sysUser.findFirst({
      where: { id: holder.userId, isSuperAdmin: false, deletedAt: null },
    });
    if (user !== null) {
      await prisma.sysUser.update({
        where: { id: user.id },
        data: { isSuperAdmin: true },
      });
      flagged += 1;
    }
  }

  console.log(`超管角色回填：角色 +${bound}，标志 +${flagged}`);
}

/**
 * 清理历史遗留的「（sso:xx）」部门后缀。
 *
 * 旧同步在「同级已有同名部门且被别的同步行占用」时会造一个带内部 code 的
 * 副本。后缀会让同一院系在 SSO 登录与定时同步之间对不上，按部门过滤被拆成
 * 两条。现在同步改为直接复用同名部门；这里把老数据也收敛回去：
 * - 有同名活跃部门 → 用户 / 同步组织改挂过去，软删带后缀的那条；
 * - 没有 → 去掉后缀，原地改名。
 */
async function cleanupSsoDeptSuffixes(): Promise<void> {
  const rows = await prisma.sysDept.findMany({
    where: { deletedAt: null, name: { contains: '（sso:' } },
  });
  let merged = 0;
  let renamed = 0;
  for (const dept of rows) {
    const base = dept.name.replace(/（sso:[^）]*）$/, '');
    if (base === dept.name) {
      continue;
    }
    const sibling = await prisma.sysDept.findFirst({
      where: {
        parentId: dept.parentId,
        name: base,
        deletedAt: null,
        id: { not: dept.id },
      },
    });
    if (sibling !== null) {
      await prisma.sysUser.updateMany({
        where: { deptId: dept.id },
        data: { deptId: sibling.id },
      });
      await prisma.syncOrgUnit.updateMany({
        where: { deptId: dept.id },
        data: { deptId: sibling.id },
      });
      await prisma.sysDept.update({
        where: { id: dept.id },
        data: { deletedAt: new Date(), deletedBy: SYSTEM_USER_ID },
      });
      merged += 1;
    } else {
      await prisma.sysDept.update({
        where: { id: dept.id },
        data: { name: base },
      });
      renamed += 1;
    }
  }
  if (merged + renamed > 0) {
    console.log(`SSO 部门后缀清理：合并 ${merged}，改名 ${renamed}`);
  }
}

async function main(): Promise<void> {
  await seedRoles();
  await seedPermissions();
  await seedConfigs();
  await cleanupSsoDeptSuffixes();

  // 用 admin 账号判断「seed 是否已经跑过」，而不是根部门的名字：
  // SSO 同步会把根部门改名（如「长沙医学院」），按名字会误判成没播过。
  const existingAdmin = await prisma.sysUser.findFirst({
    where: { username: ADMIN_USERNAME, deletedAt: null },
  });
  if (existingAdmin !== null) {
    const existingDept = await prisma.sysDept.findFirst({
      where: { parentId: null, deletedAt: null },
    });
    if (existingDept !== null) {
      console.log(
        'seed 已执行过，跳过（根部门与 admin 不重复创建；缺的角色已补）',
      );
      // 演示数据走自己的幂等逻辑：老库上第一次打开 SEED_DEMO_DATA 也要能补出来
      await seedDemoData(existingDept.id);
      await backfillTeacherRoles();
      await backfillSuperAdminRole();
      return;
    }
    // 极端情况：admin 在但根部门没了。只补根部门，不再建 admin。
    const repaired = await prisma.sysDept.create({
      data: {
        parentId: null,
        name: ROOT_DEPT_NAME,
        sortOrder: 0,
        status: 1,
        remark: '根部门，由 seed 补建',
        createdBy: SYSTEM_USER_ID,
        updatedBy: SYSTEM_USER_ID,
      },
    });
    await seedDemoData(repaired.id);
    await backfillTeacherRoles();
    await backfillSuperAdminRole();
    return;
  }

  const dept = await prisma.sysDept.create({
    data: {
      parentId: null,
      name: ROOT_DEPT_NAME,
      sortOrder: 0,
      status: 1,
      remark: '根部门，由 seed 创建',
      createdBy: SYSTEM_USER_ID,
      updatedBy: SYSTEM_USER_ID,
    },
  });

  const password =
    process.env.SEED_ADMIN_PASSWORD ?? randomBytes(9).toString('base64url');

  await prisma.sysUser.create({
    data: {
      username: ADMIN_USERNAME,
      password: hashSync(password, BCRYPT_ROUNDS),
      realName: ADMIN_REAL_NAME,
      employeeNo: ADMIN_USERNAME,
      deptId: dept.id,
      status: 1,
      isSuperAdmin: true,
      authSource: 'local',
      createdBy: SYSTEM_USER_ID,
      updatedBy: SYSTEM_USER_ID,
    },
  });

  console.log(`根部门：${ROOT_DEPT_NAME}`);
  console.log(`超管账号：${ADMIN_USERNAME}`);
  console.log(`基础角色：${SEED_ROLES.map((role) => role.code).join(' / ')}`);
  if (process.env.SEED_ADMIN_PASSWORD === undefined) {
    // 随机密码只打印这一次。落盘等于没有密码——日志、备份、屏幕分享都会带走它。
    console.log(`超管密码（只打印一次，请立刻记下）：${password}`);
  } else {
    console.log('超管密码：取自 SEED_ADMIN_PASSWORD');
  }

  await seedDemoData(dept.id);
  await backfillTeacherRoles();
  await backfillSuperAdminRole();
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
