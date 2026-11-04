# 统一认证登录与定时同步 —— 设计

> 日期：2026-11-04 ｜ 状态：待实现 ｜ 依据：《智慧校园统一身份认证系统 - 第三方应用接入文档 v1.4》

## 1. 意图与背景

学校已经上线统一身份认证（SSO），要求本系统：

1. 登录接入 SSO；
2. 每次登录成功时更新本地用户信息和密码，SSO 出问题时能用本地密码兜底；
3. 正确反馈 SSO 的错误；
4. 按 SSO 提供的数据开放接口，定时同步用户与组织架构；
5. 给前端一份新增功能文档。

当前代码已有两块骨架，但都没接真实协议：

- `/auth/sso/authorize` + `/auth/sso/callback` 走的是通用 OIDC（[oidc-sso.provider.ts](../../../src/modules/auth/sso/oidc-sso.provider.ts)），只换工号，不更新本地信息/密码，本地无账号直接 20107。
- `SyncService` 有完整的 `SyncSource` 契约、`SyncRun` 流水、增量水位和离场软删，但只有 [mock-source.ts](../../../src/modules/sync/mock-source.ts)，没有真实 SSO 源、没有定时器、没有 HTTP 触发入口。

## 2. 已拍板的决定

| # | 决定 | 说明 |
|---|---|---|
| D1 | 登录采用**后端代理 `api-login`**（方向 A） | 前端把学工号 + 密码交给本系统后端，后端调 `/sso/login/api-login`。这是唯一能同时满足「每次登录同步密码」与「SSO 故障时本地密码兜底」的方式 |
| D2 | **只有网络不可达才回退** | 超时 / DNS / 连接失败 / TLS 握手失败 → 本地 bcrypt；SSO 明确拒绝（密码错、锁定、应用禁用、签名错）**不回退** |
| D3 | 同步**教师 + 学生** | 新增 `teacher` personType；所有教师都同步，不按「是否已是导师」过滤 |
| D4 | SSO 账号的本地改密**提示去 SSO** | `PUT /auth/password` 对 `authSource = sso` 的账号返回 403 + 明确文案 |
| D5 | **首次登录本地无账号时自动建号** | 不沿用现在的 20107；建号只给默认角色（学生 / 导师），不给管理员角色 |
| D6 | 浏览器跳转 SSO **暂不改** | 现有 `/auth/sso/authorize`、`/auth/sso/callback` 保持原样，等后续决定 |
| D7 | 外校导师**本期不同步** | `externalMentor` 继续由管理员本地维护；全量离场只处理 `teacher` / `student`，不会误停用外校导师 |
| D8 | 多实例部署**默认加 Redis 锁** | 即使当前单实例也先加上，避免以后扩副本时并发同步 |
| D9 | TLS **严格校验**，SSO 前置已确认 | 已确认 Web 应用可调 `api-login` 且 60 次/分钟可提额；证书链暂不确定，先严格校验，私有 CA 再配 `SSO_CA_CERT_PATH` |

## 3. 目标 / 非目标 / 反目标

### 目标

- 教师、学生用学校账号密码登录本系统，得到本系统自己的 JWT 双令牌。
- 每次 SSO 登录成功，本地 `realName` / `deptId` / `password` 与 SSO 对齐。
- SSO 网络不可达时，用户仍能用**上一次成功登录时缓存的密码**登录。
- 定时从 SSO 同步组织树、教师、学生，复用现有 `SyncService` 的流水与离场逻辑。
- 前端有一份能照着改的文档。

### 非目标

- 不做浏览器跳转 SSO 的改造（D6）。
- 不做单点登出 SLO、不做 SSO 会话联动。
- 不把 SSO 的 `access_token` 当作本系统接口的凭证。
- 不自动给 SSO 账号绑管理员角色。
- 本期不同步外校/编外导师（`externalMentor` 仍由管理员维护）。
- 不改现有 JWT / Redis 会话版本 / 权限守卫的架构。

### 反目标（即使功能「能用」也算失败）

- SSO 说「密码错误」时用本地旧密码放行——这会让 SSO 的密码策略和锁定形同虚设。
- 定时同步只拉到半页数据就执行离场，把大批账号停用。
- 把 SSO 的 `clientSecret`、`access_token`、用户明文密码写进日志。
- 自动建号时把管理员角色/超管标志带进来。

## 4. 约束与前置条件

- SSO 生产地址 `https://sso.csmu.edu.cn`，开发 `http://localhost:24000`。
- `api-login` 需要 `clientId` + `clientSecret`。**已确认 Web 应用可调，且单应用 60 次/分钟的限制可提额**；上线前确认提额后的实际值，并据此调整本地令牌桶（默认 55 次/分钟）。
- `api-login` 的 `timestamp` 与服务端时间差必须 ≤ 5 分钟，服务器必须 NTP 同步。
- 数据开放接口需要 SSO 后台逐项勾选能力键：至少 `teachers`、`students`、`org:departments`、`edu:classes`、`edu:org`。
- 开放接口 token 只有 300 秒，必须每次请求前重新换取或缓存到过期前刷新。
- 学生接口只返回未毕业学生；已毕业学生会在全量同步中「离场」，这是预期行为。
- 教师接口的 `organization` 是部门**名称**，学生接口的 `organization` 是**班级名称**，都不是部门 ID，需要本地建映射。
- TLS 默认**严格校验**证书链；校内私有 CA 通过 `SSO_CA_CERT_PATH` 指定，生产不允许 `rejectUnauthorized: false`。证书不受信任时登录会全部失败并回退，新用户无法登录——上线前必须确认。
- 登录 provisioning 与定时同步都会写 `SyncPerson` / `SyncOrgUnit`，必须走 `runWithSyncWrite` 作用域，否则被 `SYNC_WRITE_FORBIDDEN` 拒绝。
- 生产若多实例部署，定时同步需要 Redis 锁（`SET NX EX`），否则多个副本会并发跑同一批数据、重复消耗 SSO 配额。

## 5. 总体架构

```
前端 ──POST /auth/login──> AuthService
                              │
                    ┌─────────┴──────────┐
                    │                    │
              authSource=local      authSource=sso / 本地无账号
                    │                    │
              本地 bcrypt          SsoApiLoginClient
                                         │
                              ┌──────────┴──────────┐
                         成功/凭据拒绝           网络不可达
                              │                    │
                     更新本地信息/密码        本地 bcrypt 回退
                              │                    │
                              └─────────┬──────────┘
                                  签发本地双令牌

定时器 ──> SsoSyncScheduler ──> SyncService.runOnce(SsoSyncSource)
                                      │
                              SsoOpenApiClient
                                      │
                    ┌─────────────────┼─────────────────┐
              组织树 /departments  教师 /teachers   学生 /students
                    │                 │                 │
                    └─────────> SyncOrgUnit / SyncPerson / SysDept / SysUser
```

## 6. 登录链路

### 6.1 入口与分流

保留 `POST /auth/login` 作为唯一登录入口，前端不需要改路径。

新增 `SysUser.authSource`（`local` | `sso`）：

- `local`：超管、管理员、历史本地账号。永远走本地 bcrypt，不受 SSO 影响。
- `sso`：同步来的教师/学生、首次登录自动建的号。走 SSO `api-login`，失败按第 6.5 节处理。

分流顺序：

1. 按 `username` 查本地用户。
2. 本地用户存在且 `authSource = local` → 直接本地 bcrypt。
3. 其余情况（`authSource = sso` 或本地无用户）→ 调 SSO `api-login`。
4. SSO 成功后若本地无用户 → 第 6.4 节自动建号。

> 为什么不在本地无用户时直接 20107：D5 要求自动建号；且用户第一次登录可能早于定时同步。

### 6.2 调用 `api-login`

新增 `SsoApiLoginClient`（建议 `src/modules/auth/sso/sso-api-login.client.ts`）：

```
POST {SSO_BASE_URL}/sso/login/api-login
Content-Type: application/json

{
  "username": "<学工号>",
  "password": "<明文，HTTPS 传输层已加密>",
  "clientId": "<SSO_APP_ID>",
  "appSecret": "<RSA-OAEP-SHA256 加密后的 clientSecret，base64>",
  "timestamp": <毫秒>,
  "nonce": "<16 位随机串>",
  "sign": "HMAC-SHA256(`${clientId}:${username}:${timestamp}:${nonce}`, clientSecret)"
}
```

- 每次请求生成新的 `timestamp` / `nonce`。
- `clientSecret` 用 SSO 公钥加密后放 `appSecret`；公钥从 `GET /sso/app/public-key` 获取并缓存。若 RSA 不可用，允许配置退化为明文 `appKey`，但生产默认走 RSA。
- 超时建议 5 秒；**不要**自动跟随 302（文档 Q11 提到网关重定向问题）。
- 成功响应取 `user.userName`（学工号）、`user.nickName`、`user.userType`、`user.dept`、`user.isDefaultPwd`。
- **不保存** `access_token` / `refresh_token`。

### 6.3 成功后的本地更新

按 `employeeNo = userName` 找本地用户（同步投影时 `username` 与 `employeeNo` 都取 login）：

- `realName` ← `nickName`
- `deptId` ← 按以下优先级映射，**任何一步失败都不拒绝登录**，保留原值并记 warning：
  1. `dept.deptId` 非空且能按 `sso:${deptId}` 找到本地 `SyncOrgUnit` → 用它的 `deptId`；
  2. `dept.deptName` 能按名称唯一命中本地 `SysDept` → 用它；
  3. 都命中不了 → 保留本地原值（首次建号时挂根部门）。
  学生的 `dept` 可能为空：定时同步会按「班级 → 学院」把学生挂到学院级部门；登录时不做班级级挂载。
- `password` ← 本次明文密码的 bcrypt；**先 `compareSync`，相同就不写**，避免每次登录都改 `updatedAt`
- `lastLoginAt` ← 现有 `recordLogin`
- 角色**不从 SSO 同步**：本地角色由管理员配置，SSO 的 `teacher/student` 只用于首次建号时选默认角色

密码回写必须用**不触发会话作废**的写口。现有 `UserService.changeOwnPassword` 会 `revokeSessions`，不能用；新增 `UserRepository.updatePasswordHash(id, hash)` 或在 `UserService` 加 `syncPasswordFromSso`。

### 6.4 首次登录自动建号

新增 `SsoUserProvisioner`（建议放在 `src/modules/sync/sso/`，由 `SyncModule` 导出，`AuthModule` 导入）：

1. 解析 SSO `dept` → 本地 `SyncOrgUnit` / `SysDept`；找不到时挂到根部门，并记 warning。
2. 建 `SyncPerson`：`login = userName`，`personType = teacher | student`，`orgUnitId` 指向第 1 步。
3. 建 `SysUser`：`username = employeeNo = userName`，`realName = nickName`，`password = bcrypt(明文)`，`status = 1`，`authSource = sso`，`isSuperAdmin = false`。
4. 绑默认角色：`teacher → mentor`，`student → student`（复用 `PERSON_TYPE_ROLE_CODE`）。
5. 建号成功后按 6.3 走正常签发令牌。

注意：

- `SyncPerson` / `SyncOrgUnit` 的写受 `SYNC_WRITE_FORBIDDEN` 守卫，provisioner 必须把这段包在 `runWithSyncWrite` 里；它属于「源系统数据的合法写入口」，不是业务越权。
- 不自动建 `college_admin` / `sc_admin`。
- `userType` 只接受 `teacher` / `student`；`admin` 或未知值 → **20107**（统一认证通过但本系统不为其自动建号，管理员账号由超管建）。
- 已停用的本地账号（`status != 1`）即使 SSO 成功也返回 20102，**不自动复活**。
- 自动建号失败（部门/角色缺失、DB 异常）→ **20113**（新增，provisioning 失败），不要混用 20107/20108，也不要把半成品账号留在库里。

### 6.5 回退边界

只把**网络层不可达**当作可回退：

- 可回退：`AbortError` / 超时、`ECONNREFUSED`、`ECONNRESET`、`ENOTFOUND`、`EAI_AGAIN`、TLS 握手失败、DNS 失败。
- 不可回退：HTTP 4xx/5xx 响应、SSO 返回的 `code != 200`、响应 JSON 结构异常、配置错误。

> D2 是严格口径：HTTP 5xx 默认**不回退**，避免 SSO 侧主动拒绝/维护时被本地密码绕过。若运维确需把 5xx 也当不可用，用配置 `SSO_FALLBACK_ON_5XX=true` 显式打开，默认 `false`。

回退流程：

1. 本地用户不存在 → 20108（SSO 不可用且无本地账号），不泄露「账号是否存在」。
2. `status != 1` → 20102。
3. bcrypt 校验失败 → 20101，并计入现有 `registerLoginFailure` 锁定计数。
4. 成功 → 清失败计数、`recordLogin`、签发令牌，响应 `loginSource = local-fallback`、`ssoUnavailable = true`。

锁定计数口径（避免 SSO 用户被本地计数器误伤）：

- `assertNotLocked` 只对 `authSource = local` 的本地登录和**回退路径**生效；SSO 正常路径不受本地锁定影响。
- SSO 的凭据拒绝（密码错/锁定）**不**增加本地失败计数——锁定由 SSO 自己负责。
- 只有本地 bcrypt 失败才 `registerLoginFailure`；本地被锁的用户仍可用正确的 SSO 密码登录成功。
- SSO 登录成功时清空该用户的本地失败计数，避免历史计数影响下一次回退。

### 6.6 本地密码修改

- `PUT /auth/password`：`authSource = sso` → 403 / 新增 `20112`，文案「统一认证账号请在统一认证平台修改密码」。
- `authSource = local`：行为不变。
- 管理员重置 `PUT /users/:id/password` 仍允许（作为应急回退密码），但文档要写明：该密码会在下一次 SSO 登录成功时被覆盖。
- SSO 返回 `isDefaultPwd = true` 时，登录响应透传该字段，前端提示用户去 SSO 改密，不拦截登录。

### 6.7 响应字段

在现有 `AuthTokensResponseDto` 上追加（**仅 `POST /auth/login` 填充**；`POST /auth/refresh` 与旧的 `/auth/sso/callback` 保持不返回或返回 undefined，避免改变已有契约）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `loginSource` | `'sso' \| 'local' \| 'local-fallback'` | 前端据此展示「统一认证暂不可用，已用本地密码登录」提示条 |
| `ssoUnavailable` | boolean | 是否走了回退 |
| `isDefaultPwd` | boolean? | SSO 返回时透传；本地登录不返回 |

`GET /auth/profile` 的用户对象增加 `authSource`，前端据此**隐藏**本地改密入口，而不是等调 `PUT /auth/password` 拿到 20112 才知道。用户信息更新后前端重新拉取即可。

## 7. 错误码映射

新增认证段错误码（20108–20112）：

| 本地码 | 枚举名 | HTTP | 触发 |
|---|---|---|---|
| 20108 | `AUTH_SSO_UNAVAILABLE` | 503 | 网络不可达且**无法回退**（本地无账号 / `SSO_FALLBACK_ENABLED=false`）。回退执行了但本地密码也错 → 20101 |
| 20109 | `AUTH_SSO_CONFIG_INVALID` | 502 | 应用禁用、密钥错误、签名失败、缺参数、请求过期/已使用 |
| 20110 | `AUTH_SSO_RATE_LIMITED` | 429 | SSO 单应用限流（含本地 token bucket 兜底） |
| 20111 | `AUTH_SSO_RESPONSE_INVALID` | 502 | SSO 响应缺字段/格式异常 |
| 20112 | `AUTH_SSO_PASSWORD_MANAGED` | 403 | SSO 账号调本地改密 |
| 20113 | `AUTH_SSO_PROVISION_FAILED` | 500 | 首次登录自动建号失败（部门/角色缺失、DB 异常） |

SSO 原文到本地码的映射：

| SSO `msg` | 本地码 | 是否回退 |
|---|---|---|
| `账号或密码错误` | 20101 | 否 |
| `账号已被锁定，请15分钟后再试` | 20103 | 否 |
| `该应用请求过于频繁` | 20110 | 否 |
| `应用已被禁用` / `应用密钥错误` / `签名校验失败` / `缺少签名参数` / `请求已过期` / `请求已使用` | 20109 | 否 |
| 网络错误 / 超时 / DNS / TLS | 20108 | 是 |
| 未知 `msg` | 20108（记日志） | 默认否 |

实现上建议新增 `SsoErrorClassifier`，把 SSO 响应分类成 `success | rejected | unavailable | invalid` 四种，登录链路只依赖分类结果，不散落字符串判断。

是否把 SSO 原始 `msg` 放进响应 `details`：**建议放**，这些是用户可读文案，便于前端直接展示；`clientSecret`、token 一律不出现。若安全评审不同意，则只记日志，响应只用本地文案。

## 8. 定时同步

### 8.1 开放接口 token

新增 `SsoOpenApiClient`（建议 `src/modules/sync/sso/sso-open-api.client.ts`）：

```
POST {SSO_BASE_URL}/api/auth/token
{
  "appId": SSO_APP_ID,
  "appSecret": SSO_APP_SECRET,
  "timestamp": <秒级>,
  "sign": MD5(`appId=${appId}&timestamp=${ts}&key=${appSecret}`).toUpperCase()
}
```

- token 缓存在进程内存，`expiresIn` 前 60 秒刷新。
- 业务接口 401 `无效的访问令牌` → 强制刷新 token 并重试一次。
- 请求超时 10 秒；5xx/网络错误重试 2 次（指数退避）。
- 路径兼容 `/api/...` 与经 Nginx 的 `/...`，用配置 `SSO_OPENAPI_PREFIX` 控制。
- SSO 调用统一过一个 **Redis 令牌桶**（默认 55 次/分钟，留 5 次余量，可配），多实例共享；桶空时登录返回 20110，同步本轮失败等下个周期。这是对 SSO 单应用 60 次/分钟硬限制的本地保护。
- TLS 默认严格校验；校内私有 CA 用 `SSO_CA_CERT_PATH` 指定，生产不允许关闭校验。
- `api-login` 与现有 OIDC 若共用同一个 SSO 应用注册，则 `SSO_APP_ID/SECRET` 与 `SSO_CLIENT_ID/SECRET` 应是同一套；配置校验时只允许二选一，避免出现两套凭据漂移。

### 8.2 组织架构

`GET /api/open/org/departments` 返回整棵树，**每次同步都拉全量**（接口没有 `updateTime`）。

- `code = sso:${deptId}`（加前缀避免与 mock / 历史数据的 `HQ`、`CS` 撞）。
- `parentId = "0"` → `parentCode = null`。
- `kind` 按深度推断：根 `root`，一级 `college`，其余 `department`。
- 根部门复用本地已有的根部门（`parentId = null` 的那条），避免出现两个根；根名称以 SSO 为准更新。
- `children` 为 `[]` 或 `""` 都按无下级处理。

### 8.3 人员

- 教师：`GET /api/data/teachers?page=&pageSize=&updateTime=`，`workId → login`，`name → realName`，`personType = teacher`。
- 学生：`GET /api/data/students?page=&pageSize=&updateTime=`，`studentId → login`，`name → realName`，`personType = student`。
- 分页直到 `page >= totalPages` 或 `items` 为空；`pageSize` 默认 200，可配。
- **任何一页失败 → 整批抛错**，`SyncService` 记为 FAILED，水位不推进，绝不用半截列表执行离场。
- 增量时把 `since` 转成毫秒时间戳传给 `updateTime`；全量时不传。`since` 要**减去 5 分钟安全重叠**（`since - 5min`），避免「上次同步开始后、结束前」更新的行漏掉；重复行由现有幂等写入吸收。
- 教师/学生按 `login` 去重；同一人同时出现在两边时记失败并跳过后到的那条。
- 字段映射：
  - 教师：`major = null`、`className = null`、`mobile = null`（`phone` 是脱敏密文，不落库）。
  - 学生：`className = organization`，`major` 从班级映射里取 `major_name`，`mobile = null`。
  - 学生的 `organization` 是班级名，不是部门名，见 8.4。

### 8.4 部门映射

教师：

- 用组织树建「部门名 → code」索引，`organization` 命中即用。
- 重名部门：记 warning，默认取第一个；必要时对该教师调 `/api/open/org/staffs/by-job-number/{jobNumber}` 拿权威 `deptId`（只对重名/未命中的少数人做，避免 N+1）。
- 映射不到：返回 `orgUnitCode = unresolved:teacher:${organization}`，让 `SyncService` 记 `org_not_found`，不静默丢弃。

学生：

- `GET /api/open/edu/classes` 建「班级名 → 学院名」索引；`GET /api/open/edu/org` 可作补充。
- 学生 `organization` 先按班级名查学院，再按学院名查部门 code。
- 班级名查不到但 `organization` 直接命中部门名时，直接用部门。
- 都查不到：`unresolved:student:${organization}`，记 `org_not_found`。

`SSO_SYNC_DEFAULT_DEPT_CODE` **只用于登录自动建号**的兜底部门，不用于定时同步。定时同步里映射不到的人一律记 `org_not_found`，让数据质量问题在 `SyncRun.detail` 里可见，而不是悄悄挂到一个默认部门、改变数据范围。

### 8.5 `teacher` 类型与权限影响

`SyncPerson.personType` 新增 `teacher`。必须同步修改以下位置，否则教师会出现「能登录但不能申请导师」：

- `PERSON_TYPE_ROLE_CODE` 增加 `teacher: 'mentor'`。
- `deriveMentorType`：`externalMentor → external`；`internalMentor` / `teacher → internal`。
- 所有「是不是导师」的身份门统一改为 `isMentorPersonType(personType)`，接受 `internalMentor | externalMentor | teacher`：
  - [mentor.service.ts](../../../src/modules/mentor/mentor.service.ts)
  - [mentor-application.service.ts](../../../src/modules/mentor-application/mentor-application.service.ts)
  - [mentor-material.service.ts](../../../src/modules/mentor-material/mentor-material.service.ts)
  - 对应 controller 的 Swagger 文案
- 导师检索：`mentorType = internal` → `personType in ['internalMentor', 'teacher']`；`external` → `['externalMentor']`（[mentor-search.repository.ts](../../../src/modules/mentor-search/mentor-search.repository.ts)）。
- 统计：校内计数包含 `teacher`，校外仍只算 `externalMentor`（[stats.repository.ts](../../../src/modules/stats/stats.repository.ts)、[stats.service.ts](../../../src/modules/stats/stats.service.ts)）。
- 其他只判断 `personType === 'student'` 的地方不受影响。

### 8.6 调度与全量/增量

新增 `SsoSyncScheduler`（仿 [appointment-expiry.scheduler.ts](../../../src/modules/appointment/appointment-expiry.scheduler.ts)）：

- 配置开关 `SSO_SYNC_ENABLED`，默认关闭；生产显式打开。
- `setInterval` + `unref()` + `onApplicationShutdown` 清理；单进程布尔标志防重叠，**多实例再加 Redis 锁**（`SET NX EX`，TTL 覆盖最长同步时间，结束释放）。
- 启动后首次：若没有成功的同步记录，跑一次**全量**；否则等下一个周期。
- 周期任务：默认增量；距上次全量成功超过 `SSO_SYNC_FULL_INTERVAL_SECONDS`（默认 7 天）时改跑全量。
- `SyncService.runOnce` 要**显式接受 mode**，不再用 `since === null` 反推全量。水位取「上一次 run 的 `startedAt`（OK 或 PARTIAL）减 5 分钟」，而不是只认 OK——否则只要有一行永久 `org_not_found`，每次都会判成全量并重复执行离场。
- PARTIAL 的语义：拉数成功、逐行有失败。水位仍推进，失败行靠下一次全量重试；**拉数失败**才是整批 FAILED、水位不动。
- 全量跑才执行 `retireAbsent`，并且**只对本次源负责的行**：
  - 组织：只处理 `code` 以 `sso:` 开头的行，不碰 mock / 历史 `HQ`、`CS`。
  - 人员：只处理 `personType IN ('teacher','student')` 且 `authSource = sso` 的行，不碰 `externalMentor` 和管理员。
  - 停用 `SysUser.status = 0` 时同时 `SessionStore.revokeSessions(userId)`，避免已退休的人还能用旧 access 令牌最多 2 小时。
- 根部门：SSO 源的根（`parentId = "0"`）必须复用本地已有的根部门（`SysDept.parentId IS NULL`），不能新建。`SyncService` 要为「源根」开一个特例，或让 `SsoSyncSource` 用已有根的 code 作为根行 code；否则旧的根会被离场软删。
- 失败：记 `SyncRun` FAILED，水位不推进，下个周期原样重试。

### 8.7 手动触发与观测（建议纳入）

- `POST /sync/sso/run`，body `{ mode?: 'incremental' | 'full' }`，仅超管或新权限码 `sync:run` 可调。**返回 202 + `runId`**，实际同步在后台跑——全量同步可能超过网关超时，不能同步等待。
- `GET /sync/runs?source=sso&page=&pageSize=` 查最近流水（含 `mode`、`status`、`total/ok/fail`、`detail`）。
- 没有这两个入口，联调和故障排查只能等定时器；建议本期一起做。

## 9. 数据模型与配置变更

### Schema

| 变更 | 说明 |
|---|---|
| `SysUser.authSource` | `VarChar(20)`，默认 `local`。回填谓词：`username` 命中**未软删**的 `SyncPerson.login`，且 `personType IN ('internalMentor','teacher','student')`，且 `isSuperAdmin = false`，且未绑定 `college_admin` / `sc_admin` 角色 → `sso`；其余（含 `externalMentor`、超管、管理员）保持 `local` |
| `SyncRun.mode` | `VarChar(20)` 可空，`incremental \| full` |
| `SyncPerson.personType` | 新增取值 `teacher`（字符串列，无枚举迁移） |

不需要改 `password` 长度（bcrypt 60 字符 < 100）。

### 配置（建议命名）

```env
# 登录
SSO_LOGIN_ENABLED=true
SSO_BASE_URL=https://sso.csmu.edu.cn
SSO_APP_ID=app_xxx
SSO_APP_SECRET=...
SSO_API_LOGIN_PATH=/sso/login/api-login
SSO_PUBLIC_KEY_PATH=/sso/app/public-key
SSO_API_LOGIN_TIMEOUT_MS=5000
SSO_FALLBACK_ENABLED=true
SSO_FALLBACK_ON_5XX=false

# 开放接口 / 同步
SSO_OPENAPI_PREFIX=/api
SSO_SYNC_ENABLED=false
SSO_SYNC_INTERVAL_SECONDS=21600
SSO_SYNC_FULL_INTERVAL_SECONDS=604800
SSO_SYNC_PAGE_SIZE=200
SSO_SYNC_DEFAULT_DEPT_CODE=            # 学生部门映射失败时的兜底部门，空则用根部门
```

`env.validation.ts` 要加：

- `SSO_LOGIN_ENABLED=1` 时 `SSO_BASE_URL` / `SSO_APP_ID` / `SSO_APP_SECRET` 必填。
- `SSO_SYNC_ENABLED=1` 时同上，且 `SSO_SYNC_PAGE_SIZE` 为正整数。
- 测试环境默认 `SSO_LOGIN_ENABLED=false`，保证现有 e2e 的本地登录用例不被打穿。

`SSO_LOGIN_ENABLED` 的语义要写死：

- `false`：**所有登录走本地 bcrypt**，SSO 用户只能用上一次缓存的密码。用于 SSO 未上线或应急回滚。
- `true`：SSO-first，按第 6 节分流。
- 默认 `false`；生产上线时显式打开。`SSO_FALLBACK_ENABLED` 只在 `SSO_LOGIN_ENABLED=true` 时有意义。

## 10. 前端文档

新增 `docs/前端对接-统一认证登录.md`，内容至少包括：

1. 登录接口变化：`POST /auth/login` 现在先走 SSO，SSO 网络不可达时回退本地密码。
2. 新增响应字段：`loginSource`、`ssoUnavailable`、`isDefaultPwd`。
3. 完整错误码表（20101–20112），以及每个码前端该怎么提示。
4. 回退提示条文案：「统一认证暂不可用，已使用本地密码登录」；`isDefaultPwd=true` 时提示去统一认证平台改密。
5. SSO 账号不能在本地改密（20112），引导到 SSO。
6. 定时同步的影响：用户姓名/部门可能在同步后变化，账号可能被停用（20102），前端需要重新拉 `/auth/profile` 或提示重新登录。
7. 本地账号（超管/管理员）不受 SSO 影响。
8. 首次登录自动建号的说明（学生/教师默认角色）。

同时更新现有前端文档的账号说明和登录章节，指向新文档。

## 11. 测试策略

- **单元**：签名生成、RSA 加密、错误分类、回退边界（网络错误 vs 凭据拒绝 vs 5xx）、密码相同不写、`teacher` 身份门、组织/班级映射。
- **e2e**：
  - SSO 成功 → 自动建号 + 本地信息/密码更新 + 双令牌。
  - SSO 密码错 → 20101，**不**回退。
  - SSO 超时 → 本地密码成功 → `loginSource = local-fallback`；本地密码错 → 20101。
  - 本地管理员账号 → 不调 SSO。
  - SSO 账号调 `PUT /auth/password` → 403 / 20112。
  - 同步：mock 开放接口（本地 HTTP server）→ 组织/教师/学生落库；分页失败 → FAILED 且不离场；全量离场 → 账号停用。
- 现有 `test/*.e2e-spec.ts` 必须保持绿；测试环境默认关闭 SSO 登录与同步。

## 12. 风险与待定

1. **SSO 单应用限流**：已确认可提额。上线前确认提额后的实际值，并据此调整本地 Redis 令牌桶；提额前的默认值（55 次/分钟）仍可能在高并发登录时触顶。
2. **密码本地缓存**：本地 bcrypt 存学校密码哈希，数据库泄露时可离线破解。必须用现有 bcrypt cost，且不降低。
3. **本地改密与 SSO 密码漂移**：D4 已决定禁用本地改密；管理员重置的应急密码会在下一次 SSO 登录后被覆盖，文档要写清。
4. **学生部门映射**：班级 → 学院依赖 `edu:classes` / `edu:org` 能力键和数据质量；映射失败的行会记 `org_not_found`，不会丢人但部门为空。
5. **教师重名部门**：`organization` 是名称，重名时可能挂错部门；需要按工号二次确认，或接受「先挂第一个、人工修正」。
6. **外校导师**：本期不同步；若 SSO 的 `/api/data/users`（编外）实际包含外校导师，后续再加。首次全量同步的离场逻辑必须按 `personType` 限定，否则会把 `externalMentor` 误停用。
7. **浏览器跳转**：D6 暂缓，现有 OIDC 接口与 mock 保持可用。
8. **TLS / 校内私有 CA**：如果 `sso.csmu.edu.cn` 的证书链不被 Node 信任，所有 SSO 调用都会失败并回退，新用户无法登录。上线前必须确认证书链，必要时配 `SSO_CA_CERT_PATH`。
9. **PARTIAL 永久失败行**：一行永久 `org_not_found` 会让旧的水位逻辑反复判全量；本设计已改为「显式 mode + PARTIAL 也推进水位」，实现时不要退回旧逻辑。
10. **多实例**：没有 Redis 锁时，多副本会并发同步、重复消耗 SSO 配额；部署形态需要确认。

## 13. 留给构建者的决定

以下不影响用户已拍板的方向，构建时可自行决定：

- `SsoApiLoginClient` 用 `fetch` 还是引入 HTTP 客户端（项目目前用原生 `fetch`，建议继续用原生）。
- RSA 公钥缓存时长与刷新策略；加密失败时是否允许退化为明文 `appKey`（建议生产不允许）。
- Redis 锁用 `SET NX EX` 简单锁还是带续租的实现（单实例可先不加）。
- `SyncRun.mode` 用 `VarChar(20)` 还是 `TinyInt` 枚举（建议字符串，和 `personType` 一致）。
- 前端文档的文件名与章节顺序。
- 手动同步接口的响应体细节（`runId`、`statusUrl`）。
