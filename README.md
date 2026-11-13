# mentor-back

后台服务。通用后台那部分——认证 / RBAC / 组织 / 字典 / 配置 / 日志 / 文件 /
限流 / 数据权限——**源码已经在这个仓库里**（`src/{common,infra,modules,config}`
与 `test/`），归本项目所有，要改就改。业务写在 `src/modules/` 下自己的模块里。

- **技术栈**：NestJS 11 ｜ TypeScript 5.7 ｜ Prisma 6 + MySQL 8 ｜ Redis ｜ Jest 30
- **代码怎么写**：只认 [docs/backend-coding-standards.md](docs/backend-coding-standards.md)（72 条判据）。
- **接口契约**：`pnpm docs:gen` 生成 `docs/openapi.json`（通用后台 + 本项目业务接口，一份）。

---

## 快速开始

```bash
pnpm install

# 1. 配置环境变量
cp .env.example .env
#    填 DATABASE_URL / REDIS_URL / JWT_SECRET
#    JWT_SECRET 不能少于 32 个字符：openssl rand -base64 48

# 2. 建表（Sys* 的 11 张 + 同步层 + 业务表）
pnpm db:migrate

# 3. 播种初始超管（随机密码只打印一次，记下来）
pnpm db:seed

# 4. 起服务
pnpm start:dev
```

- 接口文档 `http://localhost:3000/api-docs`
  —— **`NODE_ENV=production` 下默认不挂载**（它不登录就能打开，等于公开整套接口面）。
  内网要留一份就显式 `SWAGGER_ENABLED=1`；显式 `0` 可在非生产环境关掉。
  关掉的只是这条路由，`docs/openapi.json` 契约快照照旧由构建期脚本生成
- 健康检查 `GET /health`

要核对当前连的是哪个库，打印 `new URL(process.env.DATABASE_URL).pathname`，
**不要**把整个 URL 贴进任何报告或聊天窗口。

### 部署（v1）

**脚本都在服务器上运行**（服务器已装好 MySQL / nginx 时会自动复用，不重复安装）：

- 后端 + 管理端 + 学生端：`bash scripts/deploy/deploy.sh all`
- Docker / Compose：`bash scripts/deploy/deploy-docker.sh all`
- （可选）从本地推送到远端：`bash scripts/deploy/deploy-remote.sh all`
- （可选）本地交互向导：`bash scripts/deploy/deploy-oneclick.sh`

首次准备、systemd / nginx 示例、回滚与生产注意事项见
[docs/部署-v1.md](docs/部署-v1.md)；容器化部署见
[docs/部署-docker.md](docs/部署-docker.md)。

---

## 通用后台已经给了什么

**源码就在这个仓库里，可以改。** `src/{common,infra,modules,config}` 与 `test/`
是整套通用后台——认证 / RBAC / 组织 / 字典 / 配置 / 日志 / 文件 / 限流 / 数据权限
——连同它的单测与 e2e 一起归这个项目所有。不挂在任何运行时包上，改功能就改
`src/modules/**` 里对应的文件，改完 `pnpm test` 与 `pnpm test:e2e` 给你回归网。

| 能力 | 源码目录 | 路径 | 错误码段位 | 接口数 |
| --- | --- | --- | --- | --- |
| 认证（本地 + SSO，JWT 双令牌） | `src/modules/auth/` | `/auth/*` | 20000 | 7 |
| 用户（CRUD / 重置密码 / 分配角色 / 超管硬删） | `src/modules/user/` | `/users` | 21000 | 9 |
| 角色（CRUD / 状态 / 分配权限） | `src/modules/role/` | `/roles` | 22000 | 7 |
| 权限（菜单树 DIR / MENU / BUTTON） | `src/modules/permission/` | `/permissions` | 23000 | 5 |
| 部门（树形组织架构） | `src/modules/dept/` | `/depts` | 24000 | 5 |
| 数据范围（全校/本部门及以下/本部门/仅本人） | `src/modules/data-scope/` | 查询接口 | — | — |
| 数据字典（类型 + 字典项） | `src/modules/dict/` | `/dict-types` `/dict-items` | 25000 | 9 |
| 系统配置（可读写的运行期参数） | `src/modules/config/` | `/configs` | 26000 | 5 |
| 操作日志（append-only，before / after 快照） | `src/modules/oplog/` | `/op-logs` | 27000 | 2 |
| 文件（上传 / 预览 / 下载） | `src/modules/file/` | `/files` | 28000 | 5 |
| 限流（Redis 计数 + 登录失败锁定 20103） | `src/infra/rate-limit/` | 全站 + `/auth/login` | 10005 | — |

合计 **36 路径 / 55 操作**（含 `GET /health` 1 个），以 `pnpm docs:gen` 跑出来的
`docs/openapi.json` 为准。

横切能力在 `src/common/` 与 `src/infra/`，业务模块不要重复实现：统一响应外壳
`{ code, message, data, traceId }`、全局异常收口、class-validator 逐字段错误、
审计四字段自动填、软删除、`AsyncLocalStorage` 请求上下文、Redis 会话。

**全站默认拒绝**：新写的 Controller 不写 `@RequirePermission` 就是 403。
要匿名的口子（登录、健康检查）显式 `@Public()`。这是安全默认值，不靠人记。

### 改了它之后

这套源码归你，也就归你养——**没有自动升级路径**。上游
[`fuguiRich/general-back`](https://github.com/fuguiRich/general-back) 出了修复，
要自己 diff 两个版本决定吃不吃。所以：改之前想清楚是「我要的定制」还是
「上游本来就会修的 bug」，后者等上游发。

编码规范在 `docs/backend-coding-standards.md`（72 条判据，本项目自有一份，不看
node_modules）。模型契约在 `prisma/schema-contract.md`。

---

## 写业务模块

照着 `src/modules/config/` 抄（DTO → Controller → Service → Repository → 单测 → e2e
一整条链都在）。三件小事，忘了就是坑：

### 1. 权限码 `<资源>:<动作>`

```ts
@Get()
@RequirePermission('mentor:list')
async findPage(@Query() q: QueryMentorDto): Promise<MentorPageResponseDto> { /* … */ }
```

给普通角色用之前，把权限点种进 `/permissions`；超管跳过权限检查，本地联调能直接通。

### 2. 错误码从 30000 起

通用后台已占用 **10000-28999**（`ERROR_CODE_SEGMENTS` 里是整张登记表）。
**这个项目拥有源码**，所以业务码直接进同一个 `ErrorCode` 枚举
（`src/common/constants/error-code.ts`）——三处一起加，少一处就是一处漂移：

```ts
// 1. 枚举：导师 31000-31999
MENTOR_NOT_FOUND = 31101,

// 2. ERROR_CODE_SEGMENTS：登记段位
[31000, 31999],

// 3. ERROR_CODE_DESCRIPTIONS：`Record<ErrorCode, string>` 逼你补说明
[ErrorCode.MENTOR_NOT_FOUND]: '导师不存在',
```

`ERROR_CODE_DESCRIPTIONS` 的类型是 `Record<ErrorCode, string>`：漏了说明就编译不过，
错误码表也就自动进 /api-docs，不用手抄。抛 `new BusinessException(code, message, status)`——
外壳由全局过滤器套，**不要**自己包一层 `{ code, message, data }`。

> `src/swagger.ts` 的 `extraErrorCodes` 是给**改不到枚举**的下游用的文档层补充
> （枚举是编译期产物，外面加不进去）。本项目能改枚举，留 `{}` 即可——多一份
> 手写的说明就多一处会漂移的副本。

### 3. 数据范围是**行级过滤**，不是权限判定

「能不能点这个按钮」归 `@RequirePermission`；「列表里该出现哪些行」归
`DataScopeService.resolve()`。两者都做，别互相顶替。

```ts
const filter = await this.dataScope.resolve({ userId, isSuperAdmin, deptId });
const where = scopeToWhere(filter);   // 在 repository 里翻成 where 片段
```

三种分支各译各的：`all` 不加约束，`self` → `created_by = userId`，
`depts` → `dept_id IN (...)`。**空数组 = 一行都看不见**，不是「不限」。
业务表要按部门过滤，就得把 `dept_id` 挂在自己身上。

---

## Prisma：schema 归这个项目

Prisma **没有 schema 组合**，所以 `Sys*` 的 11 个模型定义写在**你的**
`prisma/schema.prisma` 里（生成项目时已从通用后台拼进来）。三条硬约定：

1. **迁移原样搬，不重新推导**。DDL 里有 `schema.prisma` 表达不出来的东西：
   `DATETIME(3)` 的默认值是 `(UTC_TIMESTAMP(3))`，以及软删除表上那批
   `*_active` 生成列 + 唯一键（DB-11）。重推一遍 DDL 就会丢，
   而丢了之后「软删后同名可重建」会静默撞唯一键。
   详见 `prisma/schema-contract.md`。
2. **业务表的软删除自己写**。Prisma extension 的自动过滤只认登记进
   `SOFT_DELETE_MODELS` 的模型；业务表每条读都要自己带 `deletedAt: null`，
   删除要显式 `update({ data: { deletedAt, deletedBy } })`。
3. **审计四字段由扩展填，Service 里一行都不写**。`created_at / updated_at /
   created_by / updated_by` 对**所有**模型自动填，手写赋值会盖掉真正的操作者。
   唯一的例外是 repository 的 `create`：`createdBy / updatedBy` 是类型层面的必需
   字段（列 NOT NULL 且无默认值），要写 `0n` 占位——扩展运行时会剥掉它再按当前
   操作者重写，`0n` 永远不会落库。

---

## 测试

```bash
pnpm docs:gen    # 先生成 docs/openapi.json（契约套件要拿它比对）
pnpm test        # 单测
pnpm test:e2e    # e2e（会清空业务表）
```

**`pnpm docs:gen` 排在 `pnpm test:e2e` 前面**：`test/openapi-contract` 拿
`docs/openapi.json` 与实时构建出来的文档逐字节比对，仓库里没这份文件它就红；
改了 Controller 之后也要重跑，否则一样红。

**e2e 会清空业务表**。请在 `.env.test.local` 里指向一个**独立的**测试库
（`pnpm exec dotenv run -f .env.test.local --override -- prisma migrate deploy`
建表）；没有这个文件时会退回读 `.env`——那时清的就是你的开发库。
`test/jest-e2e.json` 的 `"maxWorkers": 1` 是**正确性要求**，不是性能旋钮，不要摘。

---

## 质量门槛

交付前必须全绿（一条不减）：

```bash
# 只读 lint（lint:fix 会改写文件，没 commit 时别用）
pnpm lint

# 类型检查必须用 tsconfig.json —— tsconfig.build.json 排除了 test/，
# 跑它等于把测试文件放进类型盲区
pnpm exec tsc --noEmit -p tsconfig.json

pnpm test

# 契约快照（JWT_SECRET 走命令行一次性传入，不落盘）。它要在 test:e2e 之前，
# 契约套件拿 docs/openapi.json 与实时文档比对
JWT_SECRET=dev-only-secret pnpm docs:gen

pnpm test:e2e
```
