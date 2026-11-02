# Prisma 模型契约

`@csmu/general-back` 依赖 11 个 `Sys*` 模型。**模型定义归应用所有**，本包只提
要求——Prisma 没有 schema 组合（`schema.prisma` 不支持 `import` / `include`），
一个应用只能有一份 schema、一次 `prisma generate`。所以：

- 本包**不**发布自己的 `@prisma/client`；
- 应用的 `schema.prisma` 必须包含下面这 11 个模型（可以再加自己的业务模型）；
- 应用跑 `prisma generate`，生成的 client 就是本包 `PrismaService` 用的那一个
  （`@prisma/client` 是 peerDependency，解析到应用的那一份，不是两份）。

字段名与列名必须**逐字**一致——本包的 repository 直接写 `prisma.client.sysUser`
上的字段名，对不上是运行期错误，不是编译期错误。改名 = 违反契约。

---

## 通用约定

| 约定 | 说明 |
| --- | --- |
| 主键 | `id BigInt @id @default(autoincrement()) @db.UnsignedBigInt`。对外序列化成**字符串**（BIGINT 超过 JS 安全整数） |
| 审计四列 | `createdAt` / `updatedAt` / `createdBy` / `updatedBy`，**每张表都有**。`createdBy` / `updatedBy` 由 `createAuditedExtension` 自动填，业务代码不写 |
| 软删除两列 | `deletedAt DateTime?` / `deletedBy BigInt?`。有它们的模型必须登记进 `prisma.extension.ts` 的 `SOFT_DELETE_MODELS` |
| 时间 | `DateTime @db.DateTime(3)`，**存 UTC**（表默认值是 `UTC_TIMESTAMP(3)`） |
| 连接表 | `SysUserRole` / `SysRolePermission` **物理删除**（DB-10），没有软删除两列，也不登记进 `SOFT_DELETE_MODELS` |
| 留痕表 | `SysOpLog` 是 append-only，没有软删除两列，登记进 `APPEND_ONLY_MODELS`：只插，不改不删 |

---

## 必需模型

### SysDept — 部门 / 组织

```
id          BigInt     @id @default(autoincrement()) @db.UnsignedBigInt
parentId    BigInt?    @map("parent_id") @db.UnsignedBigInt
name        String     @db.VarChar(50)
sortOrder   Int        @default(0) @map("sort_order")
status      Int        @default(1) @db.TinyInt
remark      String?    @db.VarChar(255)
createdAt   DateTime   @default(now()) @map("created_at") @db.DateTime(3)
updatedAt   DateTime   @default(now()) @map("updated_at") @db.DateTime(3)
createdBy   BigInt     @map("created_by") @db.UnsignedBigInt
updatedBy   BigInt     @map("updated_by") @db.UnsignedBigInt
deletedAt   DateTime?  @map("deleted_at") @db.DateTime(3)
deletedBy   BigInt?    @map("deleted_by") @db.UnsignedBigInt
children    SysDept[]  @relation("DeptTree")
parent      SysDept?   @relation("DeptTree", fields: [parentId], references: [id])
users       SysUser[]
```

`status`：`1` 启用 / `0` 停用（下同）。自关联叫 `DeptTree`，名字要一致。

### SysUser — 用户

```
id            BigInt    @id @default(autoincrement()) @db.UnsignedBigInt
username      String    @db.VarChar(50)
password      String    @db.VarChar(100)      -- bcryptjs 哈希，永不对外返回
realName      String    @map("real_name") @db.VarChar(50)
employeeNo    String    @map("employee_no") @db.VarChar(50)
mobile        String?   @db.VarChar(20)
deptId        BigInt    @map("dept_id") @db.UnsignedBigInt
status        Int       @default(1) @db.TinyInt
isSuperAdmin  Boolean   @default(false) @map("is_super_admin")
lastLoginAt   DateTime? @map("last_login_at") @db.DateTime(3)
createdAt / updatedAt / createdBy / updatedBy / deletedAt / deletedBy   -- 见通用约定
dept          SysDept   @relation(fields: [deptId], references: [id])
userRoles     SysUserRole[]
```

`username` 本地登录用；`employeeNo` 学校统一认证用（SSO 拿到的就是工号）。
两者都全局唯一（见下方生成列）。`isSuperAdmin` 是**第二道门**，与权限码并列
（R6/R7）：彻底删除、超管密码重置、`isSuperAdmin` 字段本身的写入都要求调用者是超管。

### SysRole — 角色

```
id          BigInt   @id @default(autoincrement()) @db.UnsignedBigInt
name        String   @db.VarChar(50)
code        String   @db.VarChar(50)
dataScope   String   @default("self") @map("data_scope") @db.VarChar(20)
status      Int      @default(1) @db.TinyInt
remark      String?  @db.VarChar(255)
createdAt / updatedAt / createdBy / updatedBy / deletedAt / deletedBy
rolePermissions SysRolePermission[]
userRoles       SysUserRole[]
```

`dataScope` 取值必须是 `all | deptAndChildren | dept | self`
（`src/common/constants/data-scope.ts` 的 `DATA_SCOPES`）。多角色取**最宽**。

### SysPermission — 权限点 / 菜单

```
id         BigInt   @id @default(autoincrement()) @db.UnsignedBigInt
parentId   BigInt?  @map("parent_id") @db.UnsignedBigInt
type       String   @db.VarChar(10)          -- 'DIR' | 'MENU' | 'BUTTON'
code       String?  @db.VarChar(100)         -- DIR 必须为空；MENU / BUTTON 必须有
name       String   @db.VarChar(50)
path       String?  @db.VarChar(200)
component  String?  @db.VarChar(200)
icon       String?  @db.VarChar(50)
sortOrder  Int      @default(0) @map("sort_order")
status     Int      @default(1) @db.TinyInt
createdAt / updatedAt / createdBy / updatedBy / deletedAt / deletedBy
parent     SysPermission? @relation("PermissionTree", fields: [parentId], references: [id])
children   SysPermission[] @relation("PermissionTree")
rolePermissions SysRolePermission[]
```

`code` 的形状是 `^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$`（如 `user:list`）。
业务模块自己开权限码时照这个形状起名，`@RequirePermission('mentor:review')` 才比得上。

### SysUserRole / SysRolePermission — 连接表

```
-- SysUserRole
id        BigInt   @id @default(autoincrement()) @db.UnsignedBigInt
userId    BigInt   @map("user_id") @db.UnsignedBigInt
roleId    BigInt   @map("role_id") @db.UnsignedBigInt
createdAt DateTime @default(now()) @map("created_at") @db.DateTime(3)
updatedAt DateTime @default(now()) @map("updated_at") @db.DateTime(3)
createdBy BigInt   @map("created_by") @db.UnsignedBigInt
updatedBy BigInt   @map("updated_by") @db.UnsignedBigInt
user      SysUser  @relation(fields: [userId], references: [id], onDelete: Cascade)
role      SysRole  @relation(fields: [roleId], references: [id], onDelete: Cascade)

-- SysRolePermission
id           BigInt   @id @default(autoincrement()) @db.UnsignedBigInt
roleId       BigInt   @map("role_id") @db.UnsignedBigInt
permissionId BigInt   @map("permission_id") @db.UnsignedBigInt
createdAt / updatedAt / createdBy / updatedBy
role         SysRole       @relation(fields: [roleId], references: [id], onDelete: Cascade)
permission   SysPermission @relation(fields: [permissionId], references: [id], onDelete: Cascade)
```

两张表都**没有** `deletedAt` / `deletedBy`，并且有
`(user_id, role_id)` / `(role_id, permission_id)` 唯一索引——撤销授权是物理删，
再授予才不会撞上唯一键（DB-10）。

### SysDictType / SysDictItem — 数据字典

```
-- SysDictType
id        BigInt   @id @default(autoincrement()) @db.UnsignedBigInt
code      String   @db.VarChar(50)
name      String   @db.VarChar(50)
status    Int      @default(1) @db.TinyInt
remark    String?  @db.VarChar(255)
createdAt / updatedAt / createdBy / updatedBy / deletedAt / deletedBy
items     SysDictItem[]

-- SysDictItem
id         BigInt    @id @default(autoincrement()) @db.UnsignedBigInt
dictTypeId BigInt    @map("dict_type_id") @db.UnsignedBigInt
label      String    @db.VarChar(50)
value      String    @db.VarChar(50)
sortOrder  Int       @default(0) @map("sort_order")
status     Int       @default(1) @db.TinyInt
remark     String?   @db.VarChar(255)
createdAt / updatedAt / createdBy / updatedBy / deletedAt / deletedBy
dictType   SysDictType @relation(fields: [dictTypeId], references: [id])
```

唯一性是「同类型下 value 唯一」，不是全局唯一（见下方生成列）。

### SysConfig — 系统配置

```
id        BigInt   @id @default(autoincrement()) @db.UnsignedBigInt
code      String   @db.VarChar(100)
name      String   @db.VarChar(50)
value     String   @db.VarChar(500)
valueType String   @map("value_type") @db.VarChar(20)   -- 'string'|'number'|'boolean'|'json'
status    Int      @default(1) @db.TinyInt
remark    String?  @db.VarChar(255)
createdAt / updatedAt / createdBy / updatedBy / deletedAt / deletedBy
```

**没有**关系字段。`valueType` 这一列在库里没有枚举约束（历史数据 / 手工改库都可能
塞进一个不存在的类型名），所以 Service 层有 26103 兜底——DTO 上的 `@IsIn` 管的是
HTTP 入参（10001），两层都要在。

### SysOpLog — 操作日志（append-only）

```
id           BigInt   @id @default(autoincrement()) @db.UnsignedBigInt
module       String   @db.VarChar(50)
action       String   @db.VarChar(50)
targetType   String?  @map("target_type") @db.VarChar(50)
targetId     String?  @map("target_id") @db.VarChar(50)
operatorName String   @map("operator_name") @db.VarChar(50)
method       String   @db.VarChar(10)
path         String   @db.VarChar(200)
ip           String?  @db.VarChar(45)
userAgent    String?  @map("user_agent") @db.VarChar(255)
status       Int      @default(1) @db.TinyInt
errorCode    Int?     @map("error_code")
errorMsg     String?  @map("error_msg") @db.VarChar(500)
before       Json?
after        Json?
durationMs   Int      @map("duration_ms")
createdAt / updatedAt / createdBy / updatedBy
```

**没有** `deletedAt` / `deletedBy`，也不该有：删掉一条就少一条真相。
保留期由归档策略在库外管，业务代码不开「清理日志」的口子。

### SysFile — 文件

```
id           BigInt   @id @default(autoincrement()) @db.UnsignedBigInt
originName   String   @map("origin_name") @db.VarChar(255)
storageName  String   @map("storage_name") @db.VarChar(100)
ext          String   @db.VarChar(20)
mimeType     String   @map("mime_type") @db.VarChar(100)
size         Int      @db.UnsignedInt
sha256       String   @db.Char(64)
ownerType    String?  @map("owner_type") @db.VarChar(50)
ownerId      BigInt?  @map("owner_id") @db.UnsignedBigInt
createdAt / updatedAt / createdBy / updatedBy / deletedAt / deletedBy
```

`sha256` 只有普通索引，**不是**唯一键：同一份内容可以被不同的人各传一次，
各留各的 `originName`。去重要走应用层，不要在这里加唯一键。

**`ownerType` / `ownerId`（Task 8）成对出现**——只传一个是非法入参（10001），
库里也不许落出「半个归属」的行。空 = 无归属的通用文件。
`ownerType` 的取值是**业务对象模型名，PascalCase**（`'MentorApplication'` 等），
大小写敏感：检索与鉴权都按字符串精确匹配，写成 `'mentorApplication'` 就找不着。
`ownerId` 是 `BIGINT UNSIGNED`，对外一律字符串。归属不符 → **404 / `FILE_NOT_FOUND = 28101`**
（与「文件不存在」同码同文案——不告诉调用方「这文件存在但不是你的」）。

---

## 库里有、schema.prisma 里没有的部分（DB-11）

软删除的表需要「未删除的行才参与唯一约束」。MySQL 的普通 `UNIQUE KEY` 不认
软删除——已删的 `zhangsan` 会一直占着这个名字。做法是**生成列**：

```sql
ALTER TABLE `sys_user`
  ADD COLUMN `username_active` VARCHAR(50)
    GENERATED ALWAYS AS (IF(`deleted_at` IS NULL, `username`, NULL)) VIRTUAL,
  ADD UNIQUE KEY `uk_sys_user_username_active` (`username_active`);
```

`VIRTUAL` 列不落盘、不出现在 `schema.prisma` 里（Prisma 不支持生成列），
**但表上必须有**，否则「软删后重建同名」会撞唯一键。完整清单：

**契约段（`Sys*`，随通用后台的 schema 一起生成）**

| 表 | 生成列 | 唯一键 |
| --- | --- | --- |
| `sys_dept` | `name_active` | `(parent_id, name_active)` |
| `sys_user` | `username_active` / `employee_no_active` / `mobile_active` | 各自单独一个 |
| `sys_role` | `code_active` | `(code_active)` |
| `sys_permission` | `code_active` | `(code_active)` |
| `sys_dict_type` | `code_active` | `(code_active)` |
| `sys_dict_item` | `value_active` | `(dict_type_id, value_active)` |
| `sys_config` | `code_active` | `(code_active)` |
| `sys_file` | — | — |
| `sys_op_log` | — | — |

**本项目自己的表**（mentor-back，`20261027120000_add_sync_layer_and_mentor_domain`）。
不是契约，跟着本项目 schema 走——但**登记在同一张清单里**：这张清单存在的意义
就是「加表时别忘了生成列」，分两张就会有一张被忘掉。

| 表 | 生成列 | 唯一键 | 自然键是什么 |
| --- | --- | --- | --- |
| `sync_org_unit` | `code_active` | `(code_active)` | 源系统的单位编码 |
| `sync_person` | `login_active` | `(login_active)` | 学号 / 工号 |
| `mentor_profile` | `person_id_active` | `(person_id_active)` | 一人一份档案 |
| `guidance_record` | `appointment_id_active` | `(appointment_id_active)` | 一跳一行：一条预约一条指导记录 |
| `appointment_material` | `appointment_file_active` | `(appointment_file_active)` | 同一预约同一文件只挂一次 |
| `guidance_material` | `record_file_active` | `(record_file_active)` | 同一记录同一文件只挂一次 |
| `student_review` | `appointment_id_active` | `(appointment_id_active)` | 一条预约一条评价（P3） |
| `assessment` | `mentor_period_active` | `(mentor_period_active)` | 同一导师同一考核周期一条（P3） |
| `archive_item` | `target_active` | `(target_active)` | 同一 `(target_type, target_id)` 未删行只一条（P4；软删后可再归档） |

其余业务表没有自然键（`appointment` 等的唯一性靠「一跳一行」的业务规则，不靠 DB
约束），不加生成列。

> **Task 20c（`20261030180000_add_professional_title`，R28）**：`mentor_profile`
> 加 `professional_title VARCHAR(100) NULL`——职称 / 资质，自由文本（不是字典），
> **内校 / 外校都填**（与 `affiliate_org` / `social_roles` 的 R49 内校置 NULL 不同）。
> 纯增量：只有一条 `ADD COLUMN`，不回填、不动既有行，也不进唯一键。

### P2 预约域（`20261030120000_add_appointment_domain`）

五张表在 `20261027120000` 建出骨架，Task 20 补齐业务列。**全部登记进
`SOFT_DELETE_MODELS`**；`appointment_material` / `guidance_material` 虽然像连接表，
但「摘材料不删文件」——软删保留行、`SysFile` 照旧，这是 DB-10 的显式例外。

| 模型 | 表 | 关键列 | 索引 / 约束 |
| --- | --- | --- | --- |
| `MentorTimeSlot` | `mentor_time_slot` | `mentorProfileId`→`mentor_id` / `weekday`(1-7) / `startTime` / `endTime`('HH:mm') / `status`(0 关闭 / 1 开放) | `(mentor_id, weekday)` |
| `Appointment` | `appointment` | `studentPersonId`→`student_id` / `mentorProfileId`→`mentor_id` / `type`(1-5) / `status` / `requestedTime` / `proposedTime?` / `topic` / `questions` / `mode`(1 线上 / 2 线下) / `handleComment?`→`handle_comment` / `rejectReason?` / `disputeReason?`→`dispute_reason` / `adjudicateComment?`→`adjudicate_comment` / `slotId?` | `(mentor_id, status)` / `(student_id, status)` / `(status)` / `(slot_id)` |
| `AppointmentMaterial` | `appointment_material` | `appointmentId` / `fileId` / `kind`(1 项目计划书 / 2 竞赛备赛资料 / 3 其他) | `(appointment_id)` |
| `GuidanceRecord` | `guidance_record` | `appointmentId` / `actualTime`→`actual_time` / `mode`(1 线上 / 2 线下) / `coreContent`→`core_content` / `followUp`→`follow_up` / `durationMinutes`→`duration_minutes`(P3，0 = 未填) / `submittedBy` / `submittedAt` | 唯一性靠生成列唯一键 `uk_guidance_record_appointment_active`（见下） |
| `GuidanceMaterial` | `guidance_material` | `recordId`→`guidance_record_id` / `fileId` | `(guidance_record_id)` |
| `StudentReview` | `student_review` | `appointmentId` / `attitude` / `expertise` / `effect`(各 1-5) / `overallScore`→`overall_score`(DECIMAL(3,2)) / `comment?` | 唯一性靠生成列唯一键 `uk_student_review_appointment_active`（P3） |
| `Achievement` | `achievement` | `mentorId` / `type`(1 竞赛获奖 / 2 项目立项 / 3 其他) / `title` / `level`(1 国家级 … 5 院级) / `awardedAt`→`awarded_at`(DATE) / `description?` / `proofFileId?`（裸列无外键） | `(mentor_id)` / `(awarded_at)` |

> **列名说明**：实体侧按 P2 契约叫 `mentorProfileId` / `studentPersonId` / `recordId`，
> DB 列名沿用 Task 5 占位期的 `mentor_id` / `student_id` / `guidance_record_id`。
> `@map` 只做名字映射、不改既有列——改名会让迁移出现 `DROP`，且与「不改既有列名」
> 的红线冲突。**唯一例外**是 Task 20b 的 `content` → `core_content`：那里用手写
> `RENAME COLUMN`（不是 diff 生成的 `DROP` + `ADD`），零破坏。
>
> **DB-11**：`guidance_record` 是软删表，唯一约束不能建在业务列上。Task 26 的「同一预约
> 只能一条记录」由 `20261030140000_add_guidance_record_active_unique` 里的生成列
> `appointment_id_active` + 唯一键 `uk_guidance_record_appointment_active` 保证——
> 与 `mentor_profile.person_id_active` 同法。`schema.prisma` 里因此**没有** `@unique`。
>
> **Task 20b（`20261030160000_amend_appointment_domain`）**：原始需求 §2.2 / §3.4
> 到位后补列（R25 / R26）。`Appointment` 加 `questions` / `mode` / `handle_comment`；
> `GuidanceRecord` 加 `actual_time` / `mode` / `follow_up`，并把原 `content`
> **`RENAME COLUMN`** 成 `core_content`——它是「核心指导内容」的同一列，**不是**新增同义列，
> 表上不存在 `content` 与 `core_content` 并存。该迁移纯增量：零 `DROP TABLE` /
> `DROP COLUMN` / `DELETE` / `TRUNCATE`，只有 `ADD COLUMN` / `RENAME COLUMN`。
>
> **Task 27（`20261030200000_add_appointment_dispute_reason`）**：需求 §2.4「有异议
> 填写反馈申请复核」需要一个落点，`Appointment` 加 `dispute_reason VARCHAR(500) NULL`
> （`disputeReason`）。**不复用** `reject_reason`（导师拒绝预约）或 `handle_comment`
> （导师处理意见）——三者语义不同。该迁移同样纯增量，只有一条 `ADD COLUMN`。
>
> **Task 28（`20261030220000_add_appointment_adjudicate_comment`）**：需求 §4.3
> 「学生预约复核申请……不通过需填写审核意见」需要一个落点，`Appointment` 加
> `adjudicate_comment VARCHAR(500) NULL`（`adjudicateComment`）。**不复用**
> `handle_comment` / `reject_reason` / `dispute_reason`——四者语义各不相同。
> 该迁移同样纯增量，只有一条 `ADD COLUMN`。
>
> **Task 29（`20261030230000_add_appointment_material_kind`）**：需求 §2.3 的辅助
> 材料例子（项目计划书 / 竞赛备赛资料）需要分类落点，`AppointmentMaterial` 加
> `kind TINYINT NOT NULL`（1 项目计划书 / 2 竞赛备赛资料 / 3 其他）。表在 Task 20
> 建好后为空，故 NOT NULL 无需默认值。`GuidanceMaterial` **不加**：需求 §3.5 的
> 过程材料只有例子、没有分类语义，两表不对称是有意为之。该迁移同样纯增量，
> 只有一条 `ADD COLUMN`。
>
> **Task 29 返工轮 1（`20261031000000_add_material_active_unique`）**：重复挂接原
> 先只有服务层「先查后插」，并发双发可落两行。按 DB-11 补生成列唯一键
> `uk_appointment_material_file_active` / `uk_guidance_material_file_active`——
> 生成列在 `deleted_at` 非空时取 NULL，摘掉后同一 fileId 可再挂。纯增量，只有
> `ADD COLUMN` + `ADD UNIQUE KEY`。`GuidanceMaterial.recordId` 的物理列名是
> `guidance_record_id`（Task 5 占位期列名），生成列按它拼接。


本包的 `prisma/migrations/` 里就是这两段 DDL，**原样搬进应用的迁移**即可，
不要重新推导——推导出来的版本很容易漏掉某个生成列，而漏了要到「软删后重建」
那条路径才会炸。

---

## `createAuditedExtension` 的假设

`src/infra/prisma/prisma.extension.ts` 按**模型名**分派，不是按列名：

- `SOFT_DELETE_MODELS` = `SysDept, SysUser, SysRole, SysPermission, SysDictType, SysDictItem, SysConfig, SysFile` —— 这些模型的读操作自动追加 `deletedAt: null`，写操作自动填 `deletedBy`；
- `APPEND_ONLY_MODELS` = `SysOpLog` —— 拒掉 `update / updateMany / upsert / delete / deleteMany`（在软删除分支**之前**，`includingDeleted` 也过不去）；
- 其余模型（连接表 + 应用自己的业务表）：只填审计四列，不过滤软删除。

**本项目（mentor-back）在上面之外还有两条登记**，是应用自己加的，不属契约：
`SOFT_DELETE_MODELS` 追加 `SyncOrgUnit, SyncPerson`；另有
`SYNC_OWNED_MODELS = { SyncOrgUnit, SyncPerson }` 的两层写守卫（顶层按 model +
嵌套写按 args 递归）。读 `src/infra/prisma/prisma.extension.ts` 为准——这份文档
只答「通用后台给的是什么」，项目的追加以代码里的登记为准。

**业务表要接上同一套语义，就在自己的 schema 里用这 11 个模型名之外的名字，并
把需要软删的登记进 `SOFT_DELETE_MODELS`**——但那是改本包的代码，不是改配置。
现在想接，就在应用层自己写过滤；要让本包管，得提 PR。

---

## 应用怎么接

1. 把上面 11 个模型块粘进应用的 `prisma/schema.prisma`（`@@map` 不用加，列名靠
   `@map` 已经对上物理表名）。
2. 把 `prisma/migrations/` 里的两个迁移**原样**并进应用的迁移序列（或新建一个
   迁移，内容照抄 `CREATE TABLE` + 生成列那段）。
3. `pnpm prisma migrate deploy` 建表。
4. 照 `prisma/seed.ts` 种初始数据：根部门 + 超管账号 + 一套基础权限点。
5. 应用的 `schema.prisma` 可以**继续加**自己的业务模型，不受本契约限制；
   唯一要求是别改这 11 个的名字与字段。

本包 `dependencies` 里没有 `@prisma/client`，它在 `peerDependencies`——
应用装它、应用生成它，本包只消费。
