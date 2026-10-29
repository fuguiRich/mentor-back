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
  { code: 'mentor', name: '导师', dataScope: 'self' },
  {
    code: 'college_admin',
    name: '二级学院管理员',
    dataScope: 'deptAndChildren',
  },
  { code: 'sc_admin', name: '双创学院管理员', dataScope: 'all' },
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
] as const;

/**
 * 角色 → 权限点。**只绑这些，不多给**。
 *
 * - `mentor`：自助那一组。`list` 也要给——读路由的可见性断言放行「申请人本人」，
 *   但没有权限码就连 service 都进不去。
 * - `college_admin`：只能审二级学院那一跳，**不给 `review-sc`**——给了的话
 *   「二级学院越权审双创」那条 403（Task 19 的 N2）永远触发不了。
 * - `sc_admin`：审双创那一跳 + 后台改字段（计划原文：「仅双创学院管理员可用」）。
 * - `student`：一条都不给——学生不是导师，也不审核。
 */
const SEED_ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  mentor: [
    'mentor:profile',
    'mentor:profile-update',
    'mentor-application:submit',
    'mentor-application:withdraw',
    'mentor-application:list',
  ],
  college_admin: [
    'mentor-application:list',
    'mentor-application:review-college',
  ],
  sc_admin: [
    'mentor-application:list',
    'mentor-application:review-sc',
    'mentor:admin-update',
  ],
};

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
  personType: 'internalMentor' | 'externalMentor' | 'student';
  orgCode: string;
  roles: readonly string[];
}

/**
 * 同步源里会有的人：三个导师（两个内校、一个外校）+ 一个学生。
 *
 * `T002` 是外校导师——`affiliateOrg` / `socialRoles` 只有外校能填（R49），
 * 没有外校样本，那两个字段的正常路径就测不到。
 * `T003` 在外国语学院——外院的人，用来测数据范围的负断言。
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
    login: 'S001',
    realName: '陈一鸣',
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
    realName: '双创学院管理员',
    personType: 'internalMentor',
    orgCode: 'HQ',
    roles: ['sc_admin'],
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
 * 生成演示数据：组织树 + 测试账号 + 一份已生效的导师档案。
 *
 * 幂等：全部按自然键 find-then-write（部门按「同名同父」、组织按 code、
 * 人员按 login、账号按 username、档案按 personId）。重复跑不产生重复行，
 * 也不覆盖已存在行上的任何字段——管理员手工改过的演示账号不会被冲回去。
 */
async function seedDemoData(rootDeptId: bigint): Promise<void> {
  if (!DEMO_DATA_ENABLED) {
    console.log(
      '演示数据未生成（设 SEED_DEMO_DATA=1 可生成学院 / 测试账号 / 一份已生效的导师档案）',
    );
    return;
  }

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
  }

  // 管理员不在同步源里：只有 SysUser
  for (const spec of DEMO_ADMINS) {
    const org = orgs.get(spec.orgCode);
    if (org === undefined) {
      throw new Error(`演示管理员 ${spec.login} 的学院 ${spec.orgCode} 不存在`);
    }
    await ensureDemoUser(spec, org.deptId, roleIds);
  }

  // ---- 3. 一份已生效的导师档案 ----
  // 没有它，`PUT /mentor/profiles/:id`（后台改字段）与 `profile-change`
  // 都要先走完一整条入驻审核才测得到。
  const approvedPerson = await prisma.syncPerson.findFirst({
    where: { login: 'T001', deletedAt: null },
  });
  if (approvedPerson !== null) {
    const existingProfile = await prisma.mentorProfile.findFirst({
      where: { personId: approvedPerson.id, deletedAt: null },
    });
    if (existingProfile === null) {
      await prisma.mentorProfile.create({
        data: {
          personId: approvedPerson.id,
          researchFields: ['软件工程', '人工智能'],
          // 直接落 2 是刻意的：这条只为让后台接口一登录就能测。
          // 状态机在业务代码里是唯一写口，seed 走的是没有扩展的裸 client。
          status: 2,
          summary: '长期从事软件工程与人工智能方向的教学与科研工作。',
          researchAchievements: '主持省部级项目 2 项，发表论文 10 余篇。',
          guidanceExperience: '指导研究生 12 名，其中 3 名获校级优秀论文。',
          affiliateOrg: null,
          socialRoles: null,
          createdBy: SYSTEM_USER_ID,
          updatedBy: SYSTEM_USER_ID,
        },
      });
      console.log('导师档案（补建）：T001 / status=2 APPROVED');
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

async function main(): Promise<void> {
  await seedRoles();
  await seedPermissions();

  const existingDept = await prisma.sysDept.findFirst({
    // deletedAt: null 不能省：软删的根部门仍在该表里，少了这个条件
    // 重跑 seed 会把它当成已播种、跳过重建，根部门与 admin 永远回不来。
    where: { name: ROOT_DEPT_NAME, parentId: null, deletedAt: null },
  });
  if (existingDept) {
    console.log(
      'seed 已执行过，跳过（根部门与 admin 不重复创建；缺的角色已补）',
    );
    // 演示数据走自己的幂等逻辑：老库上第一次打开 SEED_DEMO_DATA 也要能补出来
    await seedDemoData(existingDept.id);
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
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
