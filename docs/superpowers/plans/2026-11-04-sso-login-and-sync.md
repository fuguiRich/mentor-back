# SSO 登录与定时同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让教师/学生用学校统一认证账号登录本系统（SSO 网络不可达时回退本地密码），并按 SSO 开放接口定时同步组织、教师、学生。

**Architecture:** 保留 `POST /auth/login` 作为唯一入口，按 `SysUser.authSource` 分流：本地账号走 bcrypt，SSO 账号调 `/sso/login/api-login`；成功后回写本地信息与密码哈希，首次登录自动建号。同步侧新增 `SsoSyncSource` 实现现有 `SyncSource` 契约，复用 `SyncService` 的流水、水位、离场逻辑，由模块内 `setInterval` + Redis 锁调度。

**Tech Stack:** NestJS 11、Prisma 6 + MySQL、Redis（ioredis）、bcryptjs、原生 `fetch`/`node:crypto`、Jest + supertest。

**Spec:** `docs/superpowers/specs/2026-11-04-sso-login-and-sync-design.md`

## Global Constraints

- 登录方向：后端代理 SSO `api-login`（方向 A），不是浏览器跳转。
- 只有**网络层不可达**（超时 / DNS / 连接失败 / TLS 握手失败）才回退本地 bcrypt；SSO 凭据拒绝、锁定、应用禁用、签名错误一律不回退。
- HTTP 5xx 默认**不回退**；只有 `SSO_FALLBACK_ON_5XX=true` 才当不可用。
- 同步范围：教师 + 学生。新增 `personType = teacher`；外校导师 `externalMentor` 本期不同步、不被离场误伤。
- 所有教师都同步，不按「是否已有导师档案」过滤。
- SSO 账号调 `PUT /auth/password` → 403 / 20112，提示去统一认证平台改密。
- 首次 SSO 登录本地无账号 → 自动建号；只绑默认角色 `teacher→mentor` / `student→student`，不给管理员角色。
- 浏览器跳转 `/auth/sso/authorize`、`/auth/sso/callback` 保持原样，不改。
- 新增错误码：20108 `AUTH_SSO_UNAVAILABLE`、20109 `AUTH_SSO_CONFIG_INVALID`、20110 `AUTH_SSO_RATE_LIMITED`、20111 `AUTH_SSO_RESPONSE_INVALID`、20112 `AUTH_SSO_PASSWORD_MANAGED`、20113 `AUTH_SSO_PROVISION_FAILED`。
- TLS 严格校验；私有 CA 用 `SSO_CA_CERT_PATH`，生产不允许 `rejectUnauthorized: false`。
- SSO 调用统一过 Redis 令牌桶（默认 55 次/分钟）；同步加 Redis 锁。
- 不把 `clientSecret`、SSO `access_token`、用户明文密码写进日志。
- 测试环境默认 `SSO_LOGIN_ENABLED=0`、`SSO_SYNC_ENABLED=0`，现有 e2e 必须保持绿。

## Review Focus

1. **SSO 用 HTTP 200 + body `code: 500` 表示密码错误**：必须归类为凭据拒绝，不能当网络故障触发本地回退，否则 SSO 密码策略被绕过。
2. **网络错误 vs HTTP 5xx**：只有前者默认回退；5xx 默认返回 20108。实现时别把 `response.ok === false` 一律当不可达。
3. **首次全量同步遇到 mock/历史组织与 `externalMentor`**：离场必须按 `sso:` 前缀和 `personType/authSource` 限定，否则会批量停用外校导师、软删共享根部门。
4. **分页中途失败**：任何一页失败都让整批 FAILED，绝不能用半截列表执行离场。
5. **`teacher` 类型进入导师身份门/检索/统计**：所有 `internalMentor` 的判定都要同时接受 `teacher`，否则教师能登录但不能申请导师、检索也查不到。

---

### Task 1: 配置、环境校验与 Redis 键

**Files:**
- Modify: `src/config/configuration.ts`
- Modify: `src/config/env.validation.ts`
- Modify: `src/config/configuration.spec.ts`
- Modify: `src/config/env.validation.spec.ts`
- Modify: `.env.example`
- Modify: `test/setup-e2e.ts`
- Modify: `src/infra/redis/redis-keys.ts`
- Modify: `test/e2e-helpers.ts`

**Interfaces:**
- Produces: `AppConfig['sso']` 新增字段（见下）；`redisKeys.ssoPrefix`、`redisKeys.sso.rateLimit(appId: string)`、`redisKeys.sso.syncLock()`。
- Consumes: 现有 `AppConfig`、`redisKeys`。

- [ ] **Step 1: 写失败的配置测试**

在 `src/config/configuration.spec.ts` 追加：

```ts
describe('configuration sso login/sync', () => {
  it('SSO_LOGIN_ENABLED / SSO_SYNC_ENABLED 默认 false', () => {
    const cfg = configuration();
    expect(cfg.sso.loginEnabled).toBe(false);
    expect(cfg.sso.syncEnabled).toBe(false);
  });

  it('SSO_LOGIN_ENABLED=true 时读取 baseUrl/appId/appSecret', () => {
    process.env.SSO_LOGIN_ENABLED = '1';
    process.env.SSO_BASE_URL = 'https://sso.example.edu';
    process.env.SSO_APP_ID = 'app_x';
    process.env.SSO_APP_SECRET = 'secret';
    const cfg = configuration();
    expect(cfg.sso.loginEnabled).toBe(true);
    expect(cfg.sso.baseUrl).toBe('https://sso.example.edu');
    expect(cfg.sso.appId).toBe('app_x');
    expect(cfg.sso.appSecret).toBe('secret');
  });
});
```

在 `src/config/env.validation.spec.ts` 追加：

```ts
it('SSO_LOGIN_ENABLED=1 但缺 SSO_APP_ID → 抛错', () => {
  expect(() =>
    validateEnv({
      DATABASE_URL: 'mysql://u:p@h/db',
      REDIS_URL: 'redis://h:6379/0',
      JWT_SECRET: 'x'.repeat(32),
      SSO_LOGIN_ENABLED: '1',
      SSO_BASE_URL: 'https://sso.example.edu',
      SSO_APP_SECRET: 'secret',
    }),
  ).toThrow(/SSO_APP_ID/);
});

it('SSO_FALLBACK_ON_5XX 不是布尔值 → 抛错', () => {
  expect(() =>
    validateEnv({
      DATABASE_URL: 'mysql://u:p@h/db',
      REDIS_URL: 'redis://h:6379/0',
      JWT_SECRET: 'x'.repeat(32),
      SSO_FALLBACK_ON_5XX: 'yes',
    }),
  ).toThrow(/SSO_FALLBACK_ON_5XX/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest src/config/configuration.spec.ts src/config/env.validation.spec.ts -v`
Expected: FAIL（`cfg.sso.loginEnabled` 不存在 / 校验未抛错）。

- [ ] **Step 3: 实现配置与校验**

`src/config/configuration.ts` 的 `sso` 增加：

```ts
loginEnabled: boolean;
baseUrl: string;
appId: string;
appSecret: string;
appSecretMode: 'rsa' | 'plain';
apiLoginPath: string;
publicKeyPath: string;
apiLoginTimeoutMs: number;
rateLimitPerMinute: number;
fallbackEnabled: boolean;
fallbackOn5xx: boolean;
caCertPath: string;
syncEnabled: boolean;
openApiPrefix: string;
syncIntervalSeconds: number;
syncFullIntervalSeconds: number;
syncPageSize: number;
syncDefaultDeptCode: string;
```

默认值：`loginEnabled=false`、`appSecretMode='rsa'`、`apiLoginPath='/sso/login/api-login'`、`publicKeyPath='/sso/app/public-key'`、`apiLoginTimeoutMs=5000`、`rateLimitPerMinute=55`、`fallbackEnabled=true`、`fallbackOn5xx=false`、`openApiPrefix='/api'`、`syncEnabled=false`、`syncIntervalSeconds=21600`、`syncFullIntervalSeconds=604800`、`syncPageSize=200`、`syncDefaultDeptCode=''`、`caCertPath=''`。

在 `configuration.ts` 加一个与 `parseSwaggerEnabled` 同风格的布尔解析函数：

```ts
function parseBool(raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '') return fallback;
  return value === '1' || value === 'true';
}
```

`env.validation.ts` 增加：

- 四个布尔项（`SSO_LOGIN_ENABLED` / `SSO_SYNC_ENABLED` / `SSO_FALLBACK_ENABLED` / `SSO_FALLBACK_ON_5XX`）只接受空串 / `1` / `0` / `true` / `false`。
- `SSO_LOGIN_ENABLED=1` 或 `SSO_SYNC_ENABLED=1` 时：`SSO_BASE_URL`、`SSO_APP_ID`、`SSO_APP_SECRET` 必填。
- `SSO_APP_SECRET_MODE` 只能是 `rsa` / `plain`。
- `SSO_API_LOGIN_TIMEOUT_MS`、`SSO_RATE_LIMIT_PER_MINUTE`、`SSO_SYNC_INTERVAL_SECONDS`、`SSO_SYNC_FULL_INTERVAL_SECONDS`、`SSO_SYNC_PAGE_SIZE` 配了就必须是正整数。
- `SSO_OPENAPI_PREFIX` 为空或以 `/` 开头（允许空串表示经 Nginx 无前缀）。

`.env.example` 增加 Global Constraints 里的全部变量与注释。

`test/setup-e2e.ts` 在 `config()` 之后、任何测试 import AppModule 之前加：

```ts
process.env.SSO_LOGIN_ENABLED ??= '0';
process.env.SSO_SYNC_ENABLED ??= '0';
```

`src/infra/redis/redis-keys.ts` 增加：

```ts
const SSO_PREFIX = 'sso';

ssoPrefix: `${SSO_PREFIX}:`,
sso: {
  rateLimit: (appId: string): string => `${SSO_PREFIX}:rate:${appId}`,
  syncLock: (): string => `${SSO_PREFIX}:sync:lock`,
},
```

`test/e2e-helpers.ts` 的 `clearRedisKeys` 的 `prefixes` 数组加入 `redisKeys.ssoPrefix`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest src/config/configuration.spec.ts src/config/env.validation.spec.ts -v`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/config src/infra/redis/redis-keys.ts test/setup-e2e.ts test/e2e-helpers.ts .env.example
git commit -m "feat(sso): add login/sync config and redis keys"
```

---

### Task 2: Schema、迁移与测试种子

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20261104090000_add_auth_source_and_sync_mode/migration.sql`
- Modify: `prisma/seed.ts`
- Modify: `test/e2e-helpers.ts`
- Modify: `src/modules/sync/sync.constants.ts`
- Modify: `src/modules/sync/contract/sync-source.ts`

**Interfaces:**
- Produces: `SysUser.authSource: string`（`'local' | 'sso'`）；`SyncRun.mode: string | null`（`'incremental' | 'full'`）；`PERSON_TYPE_ROLE_CODE.teacher = 'mentor'`；`SyncPersonRow.personType` 允许 `'teacher'`。
- Consumes: 无。

- [ ] **Step 1: 改 schema**

`SysUser` 增加：

```prisma
  /// local = 本地账号（超管/管理员）；sso = 统一认证账号
  authSource String @default("local") @map("auth_source") @db.VarChar(20)
```

`SyncRun` 增加：

```prisma
  /// incremental | full；历史行可空
  mode String? @db.VarChar(20)
```

- [ ] **Step 2: 写迁移 SQL**

```sql
ALTER TABLE `sys_user`
  ADD COLUMN `auth_source` VARCHAR(20) NOT NULL DEFAULT 'local';

UPDATE `sys_user` u
JOIN `sync_person` p
  ON p.`login` = u.`username` AND p.`deleted_at` IS NULL
SET u.`auth_source` = 'sso'
WHERE p.`person_type` IN ('internalMentor', 'teacher', 'student')
  AND u.`is_super_admin` = 0
  AND u.`deleted_at` IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM `sys_user_role` ur
    JOIN `sys_role` r ON r.`id` = ur.`role_id`
    WHERE ur.`user_id` = u.`id`
      AND r.`code` IN ('college_admin', 'sc_admin')
  );

ALTER TABLE `sync_run`
  ADD COLUMN `mode` VARCHAR(20) NULL;
```

- [ ] **Step 3: 更新 seed 与测试辅助**

`src/modules/sync/sync.constants.ts` 的 `PERSON_TYPE_ROLE_CODE` 增加 `teacher: 'mentor'`；`src/modules/sync/contract/sync-source.ts` 的 `SyncPersonRow.personType` union 增加 `'teacher'`。

`prisma/seed.ts`：

- `ensureDemoUser` 创建 `SysUser` 时按 personType 设置 `authSource`：
  `spec.personType === 'externalMentor' ? 'local' : 'sso'`。
- 超管创建处显式 `authSource: 'local'`。
- `SEED_PERMISSIONS` 增加 `{ code: 'sync:run', name: '手动触发同步' }`（超管绕过权限检查，不需要绑角色）。

`test/e2e-helpers.ts`：

- `seedSuperAdmin` 的 `sysUser.create` 增加 `authSource: 'local'`。
- `seedUser` 的 options 增加 `authSource?: 'local' | 'sso'`，默认 `'local'`，创建时写入。
- `clearBusinessTables` 不需要改；`clearSyncTables` 已在 sync 测试里。

- [ ] **Step 4: 生成并应用迁移**

Run: `npx prisma migrate dev --name add_auth_source_and_sync_mode`
Expected: 迁移创建成功，`npx prisma generate` 自动跑完。

- [ ] **Step 5: 跑现有测试确认未被打破**

Run: `npx jest src/modules/auth/auth.service.spec.ts -v`
Expected: PASS（`SysUser` fixture 需要补 `authSource` 字段；在 `sysUser()` 工厂里加 `authSource: 'local'`）。

Run: `npx jest --config ./test/jest-e2e.json test/auth.e2e-spec.ts -v`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add prisma/schema.prisma prisma/migrations prisma/seed.ts test/e2e-helpers.ts src/modules/auth/auth.service.spec.ts src/modules/sync/sync.constants.ts src/modules/sync/contract/sync-source.ts
git commit -m "feat(sso): add auth_source and sync_run.mode"
```

---

### Task 3: SSO 错误分类、签名与 api-login 客户端

**Files:**
- Create: `src/modules/auth/sso/sso-error.ts`
- Create: `src/modules/auth/sso/sso-api-login.client.ts`
- Create: `src/modules/auth/sso/sso-api-login.client.spec.ts`
- Create: `src/modules/auth/sso/sso-rate-limiter.service.ts`
- Modify: `src/common/constants/error-code.ts`
- Modify: `src/modules/auth/auth.module.ts`

**Interfaces:**
- Produces:
  - `SsoFailureKind = 'credentials' | 'locked' | 'rate_limited' | 'config' | 'unavailable' | 'invalid'`
  - `class SsoApiError extends Error { constructor(kind: SsoFailureKind, message: string, httpStatus?: number | null, ssoCode?: number | null, ssoMsg?: string | null); kind; httpStatus; ssoCode; ssoMsg }`
  - `buildApiLoginSign(clientId: string, username: string, timestampMs: number, nonce: string, secret: string): string`
  - `classifySsoFailure(input: { httpStatus: number | null; body: unknown; cause?: unknown }): SsoFailureKind`
  - `interface SsoLoginUser { userName: string; nickName: string; userType: string; deptId: string | null; deptName: string | null; isDefaultPwd: boolean | null }`
  - `class SsoApiLoginClient { constructor(config: ConfigService<AppConfig, true>, rateLimiter: SsoRateLimiter, fetchImpl: typeof fetch = fetch); login(username: string, password: string): Promise<{ user: SsoLoginUser }> }`
  - `class SsoRateLimiter { consume(): Promise<void> }`
- Consumes: `AppConfig`（Task 1）、`redisKeys.sso.rateLimit`（Task 1）。

- [ ] **Step 1: 写失败的单元测试**

`src/modules/auth/sso/sso-api-login.client.spec.ts`：

```ts
import { createHmac } from 'node:crypto';
import { classifySsoFailure, SsoApiError } from './sso-error';
import { buildApiLoginSign, SsoApiLoginClient } from './sso-api-login.client';

describe('buildApiLoginSign', () => {
  it('按 clientId:username:timestamp:nonce 做 HMAC-SHA256 hex', () => {
    const expected = createHmac('sha256', 'secret')
      .update('app_x:T001:1780371234567:nonce123')
      .digest('hex');
    expect(buildApiLoginSign('app_x', 'T001', 1780371234567, 'nonce123', 'secret')).toBe(expected);
  });
});

describe('classifySsoFailure', () => {
  it('HTTP 200 + code 500 + 账号或密码错误 → credentials', () => {
    expect(classifySsoFailure({ httpStatus: 200, body: { code: 500, msg: '账号或密码错误' } })).toBe('credentials');
  });
  it('账号已被锁定 → locked', () => {
    expect(classifySsoFailure({ httpStatus: 200, body: { code: 500, msg: '账号已被锁定，请15分钟后再试' } })).toBe('locked');
  });
  it('应用已被禁用 / 签名校验失败 → config', () => {
    expect(classifySsoFailure({ httpStatus: 200, body: { code: 500, msg: '应用已被禁用' } })).toBe('config');
    expect(classifySsoFailure({ httpStatus: 200, body: { code: 500, msg: '签名校验失败' } })).toBe('config');
  });
  it('网络 cause → unavailable', () => {
    expect(classifySsoFailure({ httpStatus: null, body: null, cause: new TypeError('fetch failed') })).toBe('unavailable');
  });
  it('未知 msg → invalid', () => {
    expect(classifySsoFailure({ httpStatus: 200, body: { code: 500, msg: '未知错误' } })).toBe('invalid');
  });
});

describe('SsoApiLoginClient', () => {
  function clientWith(fetchImpl: typeof fetch) {
    const config = {
      get: (key: string) => {
        const map: Record<string, unknown> = {
          'sso.baseUrl': 'https://sso.test',
          'sso.appId': 'app_x',
          'sso.appSecret': 'secret',
          'sso.appSecretMode': 'plain',
          'sso.apiLoginPath': '/sso/login/api-login',
          'sso.apiLoginTimeoutMs': 1000,
        };
        return map[key];
      },
      getOrThrow: (key: string) => config.get(key),
    } as never;
    const limiter = { consume: jest.fn().mockResolvedValue(undefined) } as never;
    return new SsoApiLoginClient(config, limiter, fetchImpl);
  }

  it('成功 → 解析 user', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 200, user: { userName: 'T001', nickName: '张明远', userType: 'teacher', dept: { deptId: '10', deptName: '计算机学院' }, isDefaultPwd: false } }), { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await clientWith(fetchImpl).login('T001', 'Passw0rd!');
    expect(result.user).toMatchObject({ userName: 'T001', nickName: '张明远', userType: 'teacher', deptId: '10', deptName: '计算机学院', isDefaultPwd: false });
  });

  it('凭据错误 → SsoApiError(kind=credentials)，不重试', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 500, msg: '账号或密码错误' }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(clientWith(fetchImpl).login('T001', 'bad')).rejects.toMatchObject({ kind: 'credentials' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('网络错误 → SsoApiError(kind=unavailable)', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch;
    await expect(clientWith(fetchImpl).login('T001', 'x')).rejects.toMatchObject({ kind: 'unavailable' });
  });
});
```

`SsoRateLimiter` 测试放在同一文件或单独文件：

```ts
it('超过每分钟上限 → rate_limited', async () => {
  const redis = { client: { incr: jest.fn().mockResolvedValue(56), expire: jest.fn() } } as never;
  const limiter = new SsoRateLimiter(redis, { getOrThrow: () => 55 } as never);
  await expect(limiter.consume()).rejects.toMatchObject({ kind: 'rate_limited' });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest src/modules/auth/sso/sso-api-login.client.spec.ts -v`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现错误分类与客户端**

`src/common/constants/error-code.ts` 认证段追加：

```ts
AUTH_SSO_UNAVAILABLE = 20108,
AUTH_SSO_CONFIG_INVALID = 20109,
AUTH_SSO_RATE_LIMITED = 20110,
AUTH_SSO_RESPONSE_INVALID = 20111,
AUTH_SSO_PASSWORD_MANAGED = 20112,
AUTH_SSO_PROVISION_FAILED = 20113,
```

并在错误码文案表里补对应中文。

`classifySsoFailure` 规则：

- `httpStatus === null` 或 `cause` 存在 → `unavailable`。
- `httpStatus >= 500` → `unavailable`。
- `httpStatus >= 400` → `invalid`。
- body `code !== 200` 时按 `msg`：`账号或密码错误` → `credentials`；`账号已被锁定` → `locked`；`请求过于频繁` → `rate_limited`；`应用已被禁用` / `应用密钥错误` / `签名校验失败` / `缺少签名参数` / `请求已过期` / `请求已使用` → `config`；其余 → `invalid`。
- body 成功但缺 `user` / `userName` → `invalid`。

`SsoApiLoginClient.login`：

1. `await this.rateLimiter.consume()`。
2. `timestamp = Date.now()`，`nonce = randomBytes(8).toString('hex')`。
3. `sign = buildApiLoginSign(...)`。
4. `appSecretMode === 'plain'` → body 带 `appKey: appSecret`；否则从 `${baseUrl}${publicKeyPath}` 取 PEM，用 `publicEncrypt` + `RSA_PKCS1_OAEP_PADDING` + `oaepHash: 'sha256'` 加密，base64 后放 `appSecret`。
5. `fetch(`${baseUrl}${apiLoginPath}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(...), signal: AbortSignal.timeout(timeoutMs) })`。
   - 若 `sso.caCertPath` 非空：`npm install undici`，读 PEM 后用 `new Agent({ connect: { ca: pem } })` 作为 `dispatcher` 传入 fetch；生产不允许 `rejectUnauthorized: false`。
6. 网络异常 / 超时 → `throw new SsoApiError('unavailable', ..., cause)`。
7. 解析 body；非 200 或 `code !== 200` → `classifySsoFailure` 后抛 `SsoApiError`。
8. 成功 → 返回 `{ user: { userName, nickName, userType, deptId: user.dept?.deptId ?? null, deptName: user.dept?.deptName ?? null, isDefaultPwd: user.isDefaultPwd ?? null } }`。

`SsoRateLimiter.consume`：`incr(redisKeys.sso.rateLimit(appId))`，第一次 `expire(key, 60)`；超过 `sso.rateLimitPerMinute`（Task 1 新增配置，默认 55）→ 抛 `SsoApiError('rate_limited')`。

`auth.module.ts` 把 `SsoApiLoginClient`、`SsoRateLimiter` 加进 providers，并导出 `SsoApiLoginClient`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest src/modules/auth/sso/sso-api-login.client.spec.ts -v`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/modules/auth/sso src/common/constants/error-code.ts src/modules/auth/auth.module.ts
git commit -m "feat(sso): add api-login client and error classification"
```

---

### Task 4: 首次登录自动建号（Provisioner）

**Files:**
- Create: `src/modules/sync/sso/sso-user-provisioner.ts`
- Create: `src/modules/sync/sso/sso-user-provisioner.spec.ts`
- Modify: `src/modules/sync/projection.ts`
- Modify: `src/modules/sync/sync-org.repository.ts`
- Modify: `src/modules/sync/sync-person.repository.ts`
- Modify: `src/modules/sync/sync.module.ts`

**Interfaces:**
- Consumes: `SyncOrgRepository`、`SyncPersonRepository`、`ProjectionWriter`、`PrismaService`、`runWithSyncWrite`。
- Produces:
  - `interface SsoProvisionInput { login: string; realName: string; userType: 'teacher' | 'student'; deptId: string | null; deptName: string | null; passwordHash: string }`
  - `class SsoUserProvisioner { ensureUser(input): Promise<{ userId: bigint }>; resolveDeptId(deptId, deptName): Promise<bigint | null> }`

- [ ] **Step 1: 写失败的 e2e 用例**

在 `test/auth-sso-login.e2e-spec.ts`（Task 5 会建完整套件；本任务先建最小版本）加：

```ts
it('自动建号：teacher → SysUser(authSource=sso) + SyncPerson(teacher) + mentor 角色', async () => {
  const root = await prisma.client.sysDept.findFirst({ where: { parentId: null } });
  await prisma.client.sysRole.create({ data: { code: 'mentor', name: '导师', dataScope: 'self', status: 1, createdBy: 0n, updatedBy: 0n } });

  const provisioner = app.get(SsoUserProvisioner);
  const { userId } = await provisioner.ensureUser({
    login: 'T900', realName: '教师甲', userType: 'teacher',
    deptId: '10', deptName: '计算机学院',
    passwordHash: hashSync('Passw0rd!', BCRYPT_ROUNDS),
  });

  const user = await prisma.client.sysUser.findFirst({ where: { id: userId } });
  expect(user).toMatchObject({ username: 'T900', employeeNo: 'T900', realName: '教师甲', authSource: 'sso', status: 1 });
  const person = await prisma.client.syncPerson.findFirst({ where: { login: 'T900' } });
  expect(person?.personType).toBe('teacher');
  const unit = await prisma.client.syncOrgUnit.findFirst({ where: { code: 'sso:10' } });
  expect(unit).not.toBeNull();
  const dept = await prisma.client.sysDept.findFirst({ where: { name: '计算机学院' } });
  expect(dept?.parentId).toBe(root?.id);
  const mentorRole = await prisma.client.sysRole.findFirst({ where: { code: 'mentor' } });
  const bound = await prisma.client.sysUserRole.findFirst({ where: { userId, roleId: mentorRole?.id } });
  expect(bound).not.toBeNull();
});

it('重复调用幂等：不新建第二条 SysUser / SyncPerson', async () => {
  const provisioner = app.get(SsoUserProvisioner);
  const first = await provisioner.ensureUser({ login: 'T901', realName: '教师乙', userType: 'teacher', deptId: null, deptName: null, passwordHash: hashSync('x', BCRYPT_ROUNDS) });
  const second = await provisioner.ensureUser({ login: 'T901', realName: '教师乙', userType: 'teacher', deptId: null, deptName: null, passwordHash: hashSync('x', BCRYPT_ROUNDS) });
  expect(second.userId).toBe(first.userId);
  expect(await prisma.client.sysUser.count({ where: { username: 'T901' } })).toBe(1);
  expect(await prisma.client.syncPerson.count({ where: { login: 'T901' } })).toBe(1);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest --config ./test/jest-e2e.json test/auth-sso-login.e2e-spec.ts -v`
Expected: FAIL（`SsoUserProvisioner` 不存在）。

- [ ] **Step 3: 实现 Provisioner**

`ProjectionWriter`：

- `UserProjection` 增加 `authSource: 'local' | 'sso'`。
- `createUser` 写入 `authSource`。
- 新增 `async findRootDept(): Promise<SysDept | null>`，查询 `parentId: null, deletedAt: null`。
- 新增 `async updatePassword(id: bigint, passwordHash: string): Promise<void>`，只写 `password`，**不 revoke 会话**。
- `disableUser` 注入 `SessionStore`，在 `status = 0` 后调用 `await this.sessions.revokeSessions(userId)`。

`SyncOrgUnitContent.syncRunId` / `SyncPersonContent.syncRunId` 改为 `bigint | null`。

`SyncService.projectPerson` 构造 `UserProjection` 时补 `authSource: 'sso'`——所有从同步源来的人都是 SSO 账号；管理员用 `UserRepository.createWithRoles` 建的号保持默认 `local`。

`SsoUserProvisioner` 注入 `ConfigService` 读取 `sso.syncDefaultDeptCode`。`ensureUser` 流程（整段包在 `runWithSyncWrite` 里）：

1. `resolveDeptId(deptId, deptName)`（**只读**，不建行；供登录回写使用）：
   - `deptId` 非空 → `code = 'sso:' + deptId`，查 `SyncOrgUnit`；有 `deptId` 且 `SysDept` 存在 → 返回。
   - `deptName` 非空 → 查 `SysDept.name`，**唯一命中**才用。
   - 都找不到 → 返回 `null`（调用方保留原部门；自动建号时再走下面的兜底）。
2. 自动建号时若 `resolveDeptId` 返回 null：
   - `deptId` 非空 → 建 `SyncOrgUnit(code='sso:'+deptId)`；若它没有 `deptId`，用 `projection.createDept({ name: deptName ?? '统一认证用户', parentId: root?.id ?? null, sortOrder: 0, status: 1, remark: 'SSO 登录自动建号' })` 建部门并 `linkDept`。
   - 否则用 `sso.syncDefaultDeptCode` 对应的部门；没配或找不到再用根部门（`projection.findRootDept()`）。
3. 查 `SyncPerson` by login；不存在则 `create`，`personType = userType`，`orgUnitId`，`syncedAt = new Date()`，`syncRunId = null`。
4. 查 `SysUser` by username：
   - 不存在 → `projection.createUser({ username: login, employeeNo: login, realName, mobile: null, deptId, authSource: 'sso' })`，然后 `updatePassword` 写 `passwordHash`（`createUser` 写随机密码，这里覆盖）。
   - 存在 → 若 `status !== 1` 抛 `BusinessException(20102)`；否则 `updateUser` 更新 realName/deptId；若 `compareSync` 不匹配则 `updatePassword`。
5. 若 `countUserRoles === 0`，按 `PERSON_TYPE_ROLE_CODE[userType]` 找角色并 `bindRole`；找不到角色抛 `BusinessException(20113)`。
6. 返回 `{ userId }`。

`SyncModule` providers 增加 `SsoUserProvisioner`，exports 增加它。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest --config ./test/jest-e2e.json test/auth-sso-login.e2e-spec.ts -v`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/modules/sync prisma test/auth-sso-login.e2e-spec.ts
git commit -m "feat(sso): provision local account on first sso login"
```

---

### Task 5: 登录分流、回退与密码同步

**Files:**
- Modify: `src/modules/auth/auth.service.ts`
- Modify: `src/modules/auth/auth.controller.ts`
- Modify: `src/modules/auth/dto/auth-tokens.response.dto.ts`
- Modify: `src/modules/auth/auth.module.ts`
- Modify: `src/modules/auth/auth.service.spec.ts`
- Modify: `src/modules/user/user.service.ts`
- Modify: `src/modules/user/user.repository.ts`
- Create/Extend: `test/auth-sso-login.e2e-spec.ts`

**Interfaces:**
- Consumes: `SsoApiLoginClient`（Task 3）、`SsoUserProvisioner`（Task 4）、`UserService`。
- Produces:
  - `AuthTokensResponseDto` 新增可选字段 `loginSource?: 'sso' | 'local' | 'local-fallback'`、`ssoUnavailable?: boolean`、`isDefaultPwd?: boolean | null`。
  - `UserService.syncSsoProfile(id: bigint, input: { realName: string; deptId: bigint | null; passwordHash: string | null }): Promise<void>`
  - `UserService.findByUsername` 已存在。

- [ ] **Step 1: 写失败的单元测试**

在 `src/modules/auth/auth.service.spec.ts` 的 StubBag 增加 `ssoLogin`、`provisionUser`、`resolveDeptId`、`syncSsoProfile`、`findByUsername`、`clearLoginFailures`、`getLoginFailures`。追加：

```ts
it('authSource=local → 不调 SSO，走本地 bcrypt', async () => {
  const { service, stubs } = buildService({ user: sysUser({ authSource: 'local' }) });
  const tokens = await service.login({ username: 'alice', password: OLD_PASSWORD });
  expect(stubs.ssoLogin).not.toHaveBeenCalled();
  expect(tokens.accessToken).toBeDefined();
});

it('authSource=sso + SSO 成功 → 回写密码与信息，loginSource=sso', async () => {
  const { service, stubs } = buildService({
    user: sysUser({ authSource: 'sso', password: hashSync('old', BCRYPT_ROUNDS) }),
    ssoLogin: jest.fn().mockResolvedValue({ user: { userName: 'E001', nickName: '新名字', userType: 'teacher', deptId: '10', deptName: '计算机学院', isDefaultPwd: false } }),
  });
  const tokens = await service.login({ username: 'alice', password: NEW_PASSWORD });
  expect(stubs.ssoLogin).toHaveBeenCalledWith('alice', NEW_PASSWORD);
  expect(stubs.syncSsoProfile).toHaveBeenCalledWith(1n, expect.objectContaining({ realName: '新名字', passwordHash: expect.any(String) }));
  expect(tokens.loginSource).toBe('sso');
  expect(tokens.isDefaultPwd).toBe(false);
});

it('SSO 凭据错误 → 20101，不回退本地', async () => {
  const { service, stubs } = buildService({
    user: sysUser({ authSource: 'sso', password: hashSync(NEW_PASSWORD, BCRYPT_ROUNDS) }),
    ssoLogin: jest.fn().mockRejectedValue(new SsoApiError('credentials', '账号或密码错误')),
  });
  await expect(service.login({ username: 'alice', password: NEW_PASSWORD })).rejects.toMatchObject({ code: ErrorCode.AUTH_CREDENTIALS_INVALID });
  expect(stubs.syncSsoProfile).not.toHaveBeenCalled();
});

it('SSO 不可达 + 本地密码正确 → loginSource=local-fallback', async () => {
  const { service, stubs } = buildService({
    user: sysUser({ authSource: 'sso', password: hashSync(OLD_PASSWORD, BCRYPT_ROUNDS) }),
    ssoLogin: jest.fn().mockRejectedValue(new SsoApiError('unavailable', 'timeout')),
  });
  const tokens = await service.login({ username: 'alice', password: OLD_PASSWORD });
  expect(tokens.loginSource).toBe('local-fallback');
  expect(tokens.ssoUnavailable).toBe(true);
});

it('SSO 不可达 + 本地密码错误 → 20101，并记一次失败', async () => {
  const { service, stubs } = buildService({
    user: sysUser({ authSource: 'sso', password: hashSync(OLD_PASSWORD, BCRYPT_ROUNDS) }),
    ssoLogin: jest.fn().mockRejectedValue(new SsoApiError('unavailable', 'timeout')),
  });
  await expect(service.login({ username: 'alice', password: NEW_PASSWORD })).rejects.toMatchObject({ code: ErrorCode.AUTH_CREDENTIALS_INVALID });
  expect(stubs.registerLoginFailure).toHaveBeenCalledWith('alice');
});

it('SSO 不可达 + 本地无账号 → 20108', async () => {
  const { service } = buildService({
    user: null,
    ssoLogin: jest.fn().mockRejectedValue(new SsoApiError('unavailable', 'timeout')),
  });
  await expect(service.login({ username: 'nobody', password: 'x' })).rejects.toMatchObject({ code: ErrorCode.AUTH_SSO_UNAVAILABLE });
});

it('SSO 返回 5xx 且 fallbackOn5xx=false → 20108，不回退本地', async () => {
  const { service, stubs } = buildService({
    user: sysUser({ authSource: 'sso', password: hashSync(OLD_PASSWORD, BCRYPT_ROUNDS) }),
    ssoLogin: jest.fn().mockRejectedValue(new SsoApiError('unavailable', 'bad gateway', 502)),
  });
  await expect(service.login({ username: 'alice', password: OLD_PASSWORD }))
    .rejects.toMatchObject({ code: ErrorCode.AUTH_SSO_UNAVAILABLE });
  expect(stubs.syncSsoProfile).not.toHaveBeenCalled();
});

it('SSO 锁定 / 配置错误 / 限流 / 响应异常 → 20103 / 20109 / 20110 / 20111', async () => {
  const cases = [
    ['locked', ErrorCode.AUTH_LOGIN_LOCKED],
    ['config', ErrorCode.AUTH_SSO_CONFIG_INVALID],
    ['rate_limited', ErrorCode.AUTH_SSO_RATE_LIMITED],
    ['invalid', ErrorCode.AUTH_SSO_RESPONSE_INVALID],
  ] as const;
  for (const [kind, code] of cases) {
    const { service } = buildService({
      user: sysUser({ authSource: 'sso' }),
      ssoLogin: jest.fn().mockRejectedValue(new SsoApiError(kind, kind)),
    });
    await expect(service.login({ username: 'alice', password: 'x' })).rejects.toMatchObject({ code });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest src/modules/auth/auth.service.spec.ts -v`
Expected: FAIL（`authSource` 分支、`loginSource` 不存在）。

- [ ] **Step 3: 实现登录分流**

`AuthTokensResponseDto` 增加可选字段。

`UserService`：

- `syncSsoProfile(id, { realName, deptId, passwordHash })`：
  - `repository.findById(id)` 取当前行；不存在或停用抛 `BusinessException(20102)`。
  - 用 `repository.update(id, { username: current.username, realName, ...(deptId ? { deptId } : {}) })` 更新信息。
  - `passwordHash !== null` 时 `repository.updatePassword(id, passwordHash)`（**不 revoke**）。
- `AuthService` 注入 `SsoApiLoginClient`、`SsoUserProvisioner`，以及 `config` 的 `sso.loginEnabled/fallbackEnabled/fallbackOn5xx`。

`AuthService.login`：

```ts
async login(dto: LoginDto): Promise<AuthTokensResponseDto> {
  const user = await this.users.findByUsername(dto.username);
  if (user !== null && user.authSource === 'local') return this.localLogin(dto, user);
  if (!this.config.get('sso.loginEnabled', { infer: true })) return this.localLogin(dto, user);
  return this.ssoLogin(dto, user);
}
```

`localLogin` = 现有 `login` 主体，去掉重复的 `findByUsername`。

`ssoLogin`：

1. `try { const { user: ssoUser } = await this.ssoClient.login(dto.username, dto.password); ... }`
2. 成功分支：
   - `userType` 不是 `teacher`/`student` → 20107。
   - `existing === null` → `provisioner.ensureUser({ login: ssoUser.userName, realName: ssoUser.nickName, userType, deptId: ssoUser.deptId, deptName: ssoUser.deptName, passwordHash: hashSync(dto.password, BCRYPT_ROUNDS) })`；`existing = await users.findById(result.userId)`。
   - `existing.status !== 1` → 20102。
   - `deptId = await provisioner.resolveDeptId(ssoUser.deptId, ssoUser.deptName)`。
   - `passwordHash = compareSync(dto.password, existing.password) ? null : hashSync(dto.password, BCRYPT_ROUNDS)`。
   - `await users.syncSsoProfile(existing.id, { realName: ssoUser.nickName, deptId, passwordHash })`。
   - `clearLoginFailures`、`recordLogin`、`issueTokens(..., { loginSource: 'sso', ssoUnavailable: false, isDefaultPwd: ssoUser.isDefaultPwd })`。
3. 失败分支按 `SsoApiError.kind` 映射：
   - `credentials` → 20101
   - `locked` → 20103
   - `rate_limited` → 20110
   - `config` → 20109
   - `invalid` → 20111
   - `unavailable` → `if (!fallbackEnabled || (httpStatus >= 500 && !fallbackOn5xx)) throw 20108;` 否则回退：
     - `existing === null` → 20108
     - `await assertNotLocked(dto.username)`
     - `existing.status !== 1` → 20102
     - `compareSync` 失败 → `registerLoginFailure`；达到 `LOGIN_MAX_ATTEMPTS` → 20103；否则 20101
     - 成功 → `clearLoginFailures`、`recordLogin`、`issueTokens(..., { loginSource: 'local-fallback', ssoUnavailable: true })`
4. 自动建号抛 `BusinessException(20113)` 时直接透传。

`issueTokens` 增加第 4 个可选参数 `extras?: Pick<AuthTokensResponseDto, 'loginSource' | 'ssoUnavailable' | 'isDefaultPwd'>`，合并进返回值。

`auth.controller.ts` 的 Swagger 描述补：SSO-first、回退、20108–20113。

`auth.module.ts` 的 `imports` 增加 `SyncModule`。

- [ ] **Step 4: 补 e2e**

`test/auth-sso-login.e2e-spec.ts` 用本地 `http.createServer` 起假 SSO。

**关键：不要在该文件顶部 `import { AppModule }`。** `GeneralBackModule.forRoot()` 在模块导入时就会跑 `ConfigModule.forRoot`，环境变量必须在它之前设好。做法：`beforeAll` 里先启动假服务器、写 `process.env.SSO_*`，再 `const { AppModule } = await import('../src/app.module')`，然后 `Test.createTestingModule({ imports: [AppModule] })`。`configureApp` 等不加载配置的工具照常顶部导入。`afterAll` 里把改过的 `SSO_*` 恢复原值并关闭假服务器，避免污染同进程的其他套件。

```ts
let ssoServer: Server;
let ssoBaseUrl: string;
const ssoMode = { kind: 'success' as 'success' | 'credentials' | 'unavailable' | 'locked' };

beforeAll(async () => {
  ssoServer = createServer((req, res) => {
    if (req.url === '/sso/login/api-login') {
      if (ssoMode.kind === 'unavailable') { req.socket.destroy(); return; }
      if (ssoMode.kind === 'credentials') { res.end(JSON.stringify({ code: 500, msg: '账号或密码错误' })); return; }
      if (ssoMode.kind === 'locked') { res.end(JSON.stringify({ code: 500, msg: '账号已被锁定，15分钟后再试' })); return; }
      res.end(JSON.stringify({ code: 200, user: { userName: 'T950', nickName: '教师甲', userType: 'teacher', dept: { deptId: '10', deptName: '计算机学院' }, isDefaultPwd: false } }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>((r) => ssoServer.listen(0, '127.0.0.1', r));
  ssoBaseUrl = `http://127.0.0.1:${(ssoServer.address() as AddressInfo).port}`;
  process.env.SSO_LOGIN_ENABLED = '1';
  process.env.SSO_BASE_URL = ssoBaseUrl;
  process.env.SSO_APP_ID = 'app_x';
  process.env.SSO_APP_SECRET = 'secret';
  process.env.SSO_APP_SECRET_MODE = 'plain';
  // 再 compile AppModule
});
```

用例：

- 成功：`POST /auth/login {T950, Passw0rd!}` → 200，`loginSource='sso'`；`SysUser.authSource='sso'`；`compareSync('Passw0rd!', user.password)` true；`SyncPerson.personType='teacher'`；`SysUserRole` 有 mentor。
- 密码错：`ssoMode='credentials'` → 401 / 20101，库里没有 T950。
- SSO 不可达 + 本地密码对：先成功登录一次缓存密码，再 `ssoMode='unavailable'` → 200 / `loginSource='local-fallback'`。
- SSO 不可达 + 本地密码错 → 401 / 20101。
- 锁定：`ssoMode='locked'` → 401 / 20103。
- 本地管理员：`SSO_LOGIN_ENABLED=1` 下 `seedUser(authSource:'local')` 登录 → 200 / `loginSource='local'`，假 SSO 没收到请求（记录 `hitCount`）。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx jest src/modules/auth/auth.service.spec.ts -v`
Run: `npx jest --config ./test/jest-e2e.json test/auth-sso-login.e2e-spec.ts -v`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/modules/auth src/modules/user test/auth-sso-login.e2e-spec.ts
git commit -m "feat(sso): sso-first login with local fallback"
```

---

### Task 6: 本地改密拦截与 `authSource` 暴露

**Files:**
- Modify: `src/modules/auth/auth.service.ts`
- Modify: `src/modules/user/user.mapper.ts`
- Modify: `src/modules/user/dto/user-response.dto.ts`
- Modify: `src/modules/auth/auth.service.spec.ts`
- Modify: `test/auth-sso-login.e2e-spec.ts`

**Interfaces:**
- Consumes: `SysUser.authSource`（Task 2）、错误码 20112（Task 3）。
- Produces: `UserResponseDto.authSource: 'local' | 'sso'`；`GET /auth/profile` 的 `user.authSource`。

- [ ] **Step 1: 写失败的测试**

`auth.service.spec.ts`：

```ts
it('SSO 账号改密 → 403 / 20112', async () => {
  const { service } = buildService({ user: sysUser({ authSource: 'sso' }) });
  await expect(service.changePassword(1n, { oldPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }))
    .rejects.toMatchObject({ code: ErrorCode.AUTH_SSO_PASSWORD_MANAGED });
});
```

`auth-sso-login.e2e-spec.ts`：

```ts
it('SSO 账号 PUT /auth/password → 403 / 20112', async () => {
  // 先用假 SSO 登录拿令牌
  const login = await request(...).post('/auth/login').send({ username: 'T950', password: 'Passw0rd!' }).expect(200);
  const token = (login.body as ResponseEnvelope<AuthTokensResponseDto>).data.accessToken;
  const response = await authedAgent(app, token)
    .put('/auth/password')
    .send({ oldPassword: 'Passw0rd!', newPassword: 'NewPassw0rd!' })
    .expect(403);
  expect((response.body as ResponseEnvelope<null>).code).toBe(ErrorCode.AUTH_SSO_PASSWORD_MANAGED);
});

it('GET /auth/profile 返回 authSource', async () => {
  const profile = await authedAgent(app, token).get('/auth/profile').expect(200);
  expect((profile.body as ResponseEnvelope<{ user: { authSource: string } }>).data.user.authSource).toBe('sso');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest src/modules/auth/auth.service.spec.ts -v`
Expected: FAIL（没有 20112 分支 / `authSource` 未映射）。

- [ ] **Step 3: 实现**

- `AuthService.changePassword` 在 `findById` 后加：

```ts
if (user.authSource === 'sso') {
  throw new BusinessException(ErrorCode.AUTH_SSO_PASSWORD_MANAGED, '统一认证账号请在统一认证平台修改密码', HttpStatus.FORBIDDEN);
}
```

- `UserResponseDto` 增加 `authSource: 'local' | 'sso'`，`toUserResponse` 从实体带出。
- 更新 `user.service.spec.ts` / `user.mapper` 相关 fixture。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest src/modules/auth/auth.service.spec.ts src/modules/user -v`
Run: `npx jest --config ./test/jest-e2e.json test/auth-sso-login.e2e-spec.ts -v`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/modules/auth src/modules/user test/auth-sso-login.e2e-spec.ts
git commit -m "feat(sso): block local password change for sso users"
```

---

### Task 7: `teacher` 类型与导师身份门

**Files:**
- Create: `src/common/constants/person-type.ts`
- Create: `src/common/constants/person-type.spec.ts`
- Modify: `src/modules/mentor/mentor.service.ts`
- Modify: `src/modules/mentor/mentor.mapper.ts`
- Modify: `src/modules/mentor-application/mentor-application.service.ts`
- Modify: `src/modules/mentor-material/mentor-material.service.ts`
- Modify: `src/modules/mentor-search/mentor-search.repository.ts`
- Modify: `src/modules/stats/stats.repository.ts`
- Modify: `src/modules/stats/stats.service.ts`
- Modify: `src/modules/mentor/mentor.controller.ts` / `mentor-application.controller.ts` / `mentor-material.controller.ts`（Swagger 文案）

**Interfaces:**
- Produces:
  - `const MENTOR_PERSON_TYPES = ['internalMentor', 'externalMentor', 'teacher'] as const`
  - `isMentorPersonType(value: string): boolean`
  - `deriveMentorType(value: string): 'internal' | 'external'`
  - `StatsRepository.countApprovedByPersonType(base, personTypes: readonly string[])`

- [ ] **Step 1: 写失败的单元测试**

`src/common/constants/person-type.spec.ts`：

```ts
import { deriveMentorType, isMentorPersonType } from './person-type';

it('teacher 是导师，且算校内', () => {
  expect(isMentorPersonType('teacher')).toBe(true);
  expect(deriveMentorType('teacher')).toBe('internal');
});
it('student 不是导师', () => {
  expect(isMentorPersonType('student')).toBe(false);
});
it('externalMentor 算校外', () => {
  expect(deriveMentorType('externalMentor')).toBe('external');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest src/common/constants/person-type.spec.ts -v`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现并替换身份门**

`src/common/constants/person-type.ts`：

```ts
export const MENTOR_PERSON_TYPES = ['internalMentor', 'externalMentor', 'teacher'] as const;
export function isMentorPersonType(value: string): boolean {
  return (MENTOR_PERSON_TYPES as readonly string[]).includes(value);
}
export function deriveMentorType(value: string): 'internal' | 'external' {
  return value === 'externalMentor' ? 'external' : 'internal';
}
```

替换三处 Service 的身份门：

```ts
if (person === null || !isMentorPersonType(person.personType)) {
  throw new BusinessException(ErrorCode.FORBIDDEN, '只有导师（internalMentor / externalMentor）有专业档案', HttpStatus.FORBIDDEN);
}
```

**错误文案保持不变**（现有 e2e 可能断言它），只放宽判定；Swagger 文案再补 `teacher`。

`mentor-material.service.ts` 的 `person.personType === 'student'` 判断保持不变（teacher 自然放行）。

`mentor.mapper.ts` 改为调用 `deriveMentorType`。

`mentor-search.repository.ts`：

```ts
person: {
  personType: params.mentorType === 'external'
    ? 'externalMentor'
    : { in: ['internalMentor', 'teacher'] },
}
```

`stats.repository.ts` 签名改为 `personTypes: readonly string[]`，where 用 `AND: [base, { status: 2, person: { personType: { in: [...personTypes] } } }]`，让已有 `base.person` 的部门范围与类型集合求交，而不是互相覆盖。`stats.service.ts` 的 `countApprovedByPersonType` 调用改为 `['internalMentor', 'teacher']` 与 `['externalMentor']`；`buildProfileBase` 里 `mentorType === 'internal'` 的 `person.personType` 改为 `{ in: ['internalMentor', 'teacher'] }`，`external` 仍为 `'externalMentor'`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest src/common/constants/person-type.spec.ts -v`
Run: `npx jest src/modules/mentor src/modules/mentor-search src/modules/stats -v`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/common/constants/person-type.ts src/common/constants/person-type.spec.ts src/modules/mentor src/modules/mentor-application src/modules/mentor-material src/modules/mentor-search src/modules/stats
git commit -m "feat(mentor): support teacher person type"
```

---

### Task 8: SSO 开放接口客户端

**Files:**
- Create: `src/modules/sync/sso/sso-open-api.client.ts`
- Create: `src/modules/sync/sso/sso-open-api.types.ts`
- Create: `src/modules/sync/sso/sso-open-api.client.spec.ts`
- Modify: `src/modules/sync/sync.module.ts`

**Interfaces:**
- Produces:
  - `buildOpenApiSign(appId: string, timestampSeconds: number, appSecret: string): string`
  - `class SsoOpenApiError extends Error { status: number | null; msg: string | null }`
  - `class SsoOpenApiClient` 方法：
    - `constructor(config: ConfigService<AppConfig, true>, fetchImpl: typeof fetch = fetch)`
    - `getOrgDepartments(): Promise<SsoOrgDept[]>`
    - `getTeachers(since: Date | null): Promise<SsoTeacher[]>`
    - `getStudents(since: Date | null): Promise<SsoStudent[]>`
    - `getClasses(): Promise<SsoClass[]>`
    - `getEduOrg(): Promise<SsoEduCollege[]>`
- Consumes: `AppConfig`（Task 1）。

- [ ] **Step 1: 写失败的单元测试**

```ts
import { createHash } from 'node:crypto';
import { buildOpenApiSign, SsoOpenApiClient } from './sso-open-api.client';

it('sign = MD5(appId=...&timestamp=...&key=...).toUpperCase()', () => {
  const expected = createHash('md5').update('appId=app_x&timestamp=1780371234&key=secret').digest('hex').toUpperCase();
  expect(buildOpenApiSign('app_x', 1780371234, 'secret')).toBe(expected);
});

it('token 缓存；业务接口 401 时刷新一次并重试', async () => {
  const calls: string[] = [];
  const fetchImpl = jest.fn(async (url: string) => {
    calls.push(url);
    if (url.endsWith('/auth/token')) return new Response(JSON.stringify({ code: 200, token: 't1', expiresIn: 300 }), { status: 200 });
    if (calls.filter((u) => u.endsWith('/data/teachers')).length === 1) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ code: 200, total: 1, page: 1, pageSize: 200, totalPages: 1, items: [{ workId: 'T1', name: '张三', organization: '计算机学院' }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = makeClient(fetchImpl);
  const teachers = await client.getTeachers(null);
  expect(teachers).toHaveLength(1);
  expect(calls.filter((u) => u.endsWith('/auth/token'))).toHaveLength(2);
});

it('分页：totalPages=3 时拉三页', async () => { /* fake fetch 按 page 返回 */ });

it('updateTime 传毫秒时间戳', async () => {
  const fetchImpl = jest.fn(async (url: string) => {
    if (url.includes('/data/students')) {
      expect(new URL(url).searchParams.get('updateTime')).toBe('1780371234000');
      return new Response(JSON.stringify({ code: 200, total: 0, page: 1, pageSize: 200, totalPages: 0, items: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 200, token: 't', expiresIn: 300 }), { status: 200 });
  }) as unknown as typeof fetch;
  await makeClient(fetchImpl).getStudents(new Date(1780371234000));
});
```

`makeClient` 构造一个 `ConfigService` 桩：`sso.baseUrl='https://sso.test'`、`sso.openApiPrefix='/api'`、`sso.appId='app_x'`、`sso.appSecret='secret'`、`sso.syncPageSize=200`、`sso.apiLoginTimeoutMs=1000`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest src/modules/sync/sso/sso-open-api.client.spec.ts -v`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现客户端**

- `buildOpenApiSign` 用 `createHash('md5').update(...).digest('hex').toUpperCase()`。
- `getToken(force = false)`：内存缓存 `{ token, expiresAt }`；`expiresAt = Date.now() + (expiresIn - 60) * 1000`；`force` 时清缓存。
- 请求封装 `request<T>(path, query?)`：
  - `Authorization: Bearer <token>`。
  - `AbortSignal.timeout(timeoutMs)`。
  - `sso.caCertPath` 非空时与 Task 3 一样用 `undici.Agent` 传 `ca`。
  - 401 时 `getToken(true)` 后重试一次。
  - 非 2xx 或 body `code !== 200` → 抛 `SsoOpenApiError(status, msg)`。
- `getTeachers/getStudents`：循环 `page=1..`，`pageSize=syncPageSize`，`updateTime = since ? since.getTime() : undefined`；把 `items` 拼起来；`page >= totalPages` 或 `items.length === 0` 停止；最多 1000 页。
- `getOrgDepartments`：`GET ${prefix}/open/org/departments`，返回 `items`。
- `getClasses`：`GET ${prefix}/open/edu/classes`，返回 `items`。
- `getEduOrg`：`GET ${prefix}/open/edu/org`，把 `items[].colleges` 摊平后返回。

`SsoOpenApiError` 的 `msg` 用于 `SyncRun.detail` 的失败原因，**不要**把 token/secret 放进去。

`sync.module.ts` providers 增加 `SsoOpenApiClient`，exports 增加它。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest src/modules/sync/sso/sso-open-api.client.spec.ts -v`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/modules/sync/sso src/modules/sync/sync.module.ts
git commit -m "feat(sync): add sso open api client"
```

---

### Task 9: `SsoSyncSource` 与 `SyncService` 改造

**Files:**
- Create: `src/modules/sync/sso/sso-sync.source.ts`
- Create: `src/modules/sync/sso/sso-sync.source.spec.ts`
- Modify: `src/modules/sync/contract/sync-source.ts`
- Modify: `src/modules/sync/sync.service.ts`
- Modify: `src/modules/sync/sync-run.repository.ts`
- Modify: `src/modules/sync/projection.ts`
- Modify: `test/sync.e2e-spec.ts`
- Create: `test/sso-sync.e2e-spec.ts`

**Interfaces:**
- Consumes: `SsoOpenApiClient`（Task 8）、`SyncService`、`ProjectionWriter`。
- Produces:
  - `interface SyncRetirementScope { orgCodePrefix?: string; personTypes?: readonly string[]; authSources?: readonly string[] }`
  - `SyncSource.retirementScope?: SyncRetirementScope`、`SyncSource.reuseRootDept?: boolean`
  - `SyncRunRepository.findLastUsableStartedAt(source): Promise<Date | null>`（OK/PARTIAL 的最近 `startedAt`）
  - `SyncRunRepository.findLastFinishedByMode(source, mode): Promise<Date | null>`
  - `SyncRunRepository.findPage(source, page, pageSize)`
  - `SyncService.startRun(source, options): Promise<SyncRun>` / `executeRun(source, run, options): Promise<SyncRunResult>`

- [ ] **Step 1: 写失败的映射单元测试**

`src/modules/sync/sso/sso-sync.source.spec.ts`：

```ts
it('组织树摊平：parentId=0 → parentCode=null，code 加 sso: 前缀', async () => {
  const source = makeSource({
    getOrgDepartments: async () => [
      { deptId: '1', parentId: '0', deptName: '长沙医学院', children: [
        { deptId: '10', parentId: '1', deptName: '计算机学院', children: [] },
      ] },
    ],
  });
  const rows = await source.fetchOrgUnits(null);
  expect(rows).toEqual([
    { code: 'sso:1', name: '长沙医学院', parentCode: null, kind: 'root' },
    { code: 'sso:10', name: '计算机学院', parentCode: 'sso:1', kind: 'college' },
  ]);
});

it('教师按部门名映射到 sso:code；学生按班级→学院映射', async () => {
  const source = makeSource({
    getOrgDepartments: async () => [
      { deptId: '1', parentId: '0', deptName: '学校', children: [
        { deptId: '10', parentId: '1', deptName: '计算机学院', children: [] },
      ] },
    ],
    getTeachers: async () => [{ workId: 'T1', name: '张三', organization: '计算机学院' }],
    getStudents: async () => [{ studentId: 'S1', name: '李四', organization: '软工2301' }],
    getClasses: async () => [{ class_name: '软工2301', college_name: '计算机学院', major_name: '软件工程' }],
  });
  const persons = await source.fetchPersons(null);
  expect(persons).toEqual([
    expect.objectContaining({ login: 'T1', personType: 'teacher', orgUnitCode: 'sso:10' }),
    expect.objectContaining({ login: 'S1', personType: 'student', orgUnitCode: 'sso:10', className: '软工2301', major: '软件工程' }),
  ]);
});

it('映射不到 → unresolved:...，交给 SyncService 记 org_not_found', async () => {
  const source = makeSource({
    getOrgDepartments: async () => [],
    getTeachers: async () => [{ workId: 'T2', name: '王五', organization: '不存在学院' }],
    getStudents: async () => [],
    getClasses: async () => [],
  });
  const persons = await source.fetchPersons(null);
  expect(persons[0].orgUnitCode).toBe('unresolved:teacher:不存在学院');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest src/modules/sync/sso/sso-sync.source.spec.ts -v`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `SsoSyncSource`**

- `name = 'sso'`。
- `retirementScope = { orgCodePrefix: 'sso:', personTypes: ['teacher', 'student'], authSources: ['sso'] }`。
- `reuseRootDept = true`。
- `fetchOrgUnits`：拉整棵树，深度优先摊平；`code = 'sso:' + deptId`；`parentCode = parentId === '0' ? null : 'sso:' + parentId`；`kind = depth === 0 ? 'root' : depth === 1 ? 'college' : 'department'`；`children` 为 `''` 或空数组都当无下级。
- `fetchPersons(since)`：
  - 先拉组织树建 `name → code` 索引。
  - 拉班级建 `class_name → { college_name, major_name }`。
  - 教师：`getTeachers(since)`，`login=workId`，`realName=name`，`personType='teacher'`，`orgUnitCode = index.get(organization) ?? 'unresolved:teacher:' + organization`，`major/className/mobile = null`。
  - 学生：`getStudents(since)`，`login=studentId`，`personType='student'`，`className=organization`，`major=classMap.get(organization)?.major_name ?? null`，`orgUnitCode = deptIndex.get(classMap.get(organization)?.college_name ?? organization) ?? 'unresolved:student:' + organization`。
  - 按 login 去重；重复记一条 `unique_key_conflict` 由 `SyncService.dedupeBy` 处理（直接返回重复行即可）。
- `fetchPersons` 中任何一页失败都让异常冒泡（`SsoOpenApiClient` 已经抛）。

`sync.module.ts` providers 增加 `SsoSyncSource`，exports 增加它。

- [ ] **Step 4: 改造 `SyncService`**

- `runOnce(source, options)`：
  ```ts
  const last = await this.runs.findLastUsableStartedAt(source.name);
  const mode: SyncMode = options.mode === 'full' ? 'full' : last === null ? 'full' : 'incremental';
  const since = mode === 'full' ? null : new Date(last.getTime() - 5 * 60 * 1000);
  ```
- `SyncRunRepository.start(source, mode)` 写入 `mode`。
- `findLastUsableStartedAt` 查询 `status in (OK, PARTIAL)`，按 `startedAt desc`。
- `retireAbsent(..., source)`：
  - 组织：`scope.orgCodePrefix` 存在时只处理 `unit.code.startsWith(prefix)` 的行；**跳过 `parentId === null` 的根行**（或 `deptId` 等于根部门 id 的行），绝不软删共享根部门。
  - 人员：`scope.personTypes` 存在时只处理 `person.personType` 命中的行；`scope.authSources` 存在时再查 `projection.findUser(person.login)`，只处理 `user.authSource` 命中的行。
- `syncOrgUnits`/`linkAndProject` 接收 `source`；`linkAndProject` 在 `row.parentCode === null && source.reuseRootDept` 时：
  - `const root = await this.projection.findRootDept()`；存在则 `updateDept(root, desired)` 并 `linkDept`，不新建。
- `runOnce` 拆成 `startRun` + `executeRun`：
  ```ts
  async startRun(source: SyncSource, options: { mode: SyncMode }): Promise<SyncRun>
  async executeRun(source: SyncSource, run: SyncRun, options: { mode: SyncMode }): Promise<SyncRunResult>
  async runOnce(source: SyncSource, options: { mode?: SyncMode } = {}): Promise<SyncRunResult>
  ```
  `runOnce` 先算 mode 再 `startRun` + `executeRun`；`startRun` 自己也解析一次有效 mode（请求 `incremental` 但没有可用水位 → `full`），并把有效 mode 写进 `SyncRun.mode`；`executeRun` 只认 `run.mode`，负责所有现有逻辑并在结束时 `runs.finish`。

- [ ] **Step 5: 更新旧的水位用例**

`test/sync.e2e-spec.ts` 的 `Ruling 25` 用例改为新语义：

- 第一次默认 → full。
- 第二次默认 → incremental，`since = 第一次 startedAt - 5min`。
- PARTIAL → **水位推进**到本次 `startedAt - 5min`。
- 下一次默认 → incremental，`since = PARTIAL 的 startedAt - 5min`；失败行不会在增量里重试。
- 显式 `{ mode: 'full' }` → `since = null`，失败行重试成功。

- [ ] **Step 6: 写 `test/sso-sync.e2e-spec.ts`**

用本地 `http.createServer` 假开放接口，返回组织树、教师、学生、班级。

**不要靠环境变量驱动这个套件**：直接 `new SsoOpenApiClient(stubConfig, fakeFetch)` + `new SsoSyncSource(client)`，把 `source` 传给 `app.get(SyncService).runOnce(source, { mode })`。这样不必在导入 `AppModule` 前改环境，也不会让 `SSO_SYNC_ENABLED` 影响其他套件。

用例：

1. 全量同步 → `SyncRun.mode='full'`、`status=OK`；`SyncOrgUnit` 有 `sso:1`、`sso:10`；`SysDept` 根复用（不新增第二个 `parentId=null` 的部门）；教师 `personType='teacher'`、`authSource='sso'`、绑 mentor；学生 `personType='student'`、绑 student。
2. 离场范围：先种一个 `externalMentor` 用户和一个 `HQ` mock 组织；SSO 全量同步返回空人员/空组织 → `externalMentor.status` 仍为 1、`HQ` 组织未软删、`sso:*` 行软删、`sso:*` 用户 `status=0`；根部门 `deletedAt` 仍为 null。
3. 分页失败：第 2 页返回 500 → `SyncRun.status=FAILED`；第一批用户没有被停用。
4. 增量：第二次同步请求 URL 带 `updateTime`（毫秒）。

- [ ] **Step 7: 运行测试确认通过**

Run: `npx jest src/modules/sync/sso/sso-sync.source.spec.ts -v`
Run: `npx jest --config ./test/jest-e2e.json test/sync.e2e-spec.ts -v`
Run: `npx jest --config ./test/jest-e2e.json test/sso-sync.e2e-spec.ts -v`
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add src/modules/sync test/sync.e2e-spec.ts test/sso-sync.e2e-spec.ts
git commit -m "feat(sync): add sso sync source and scoped retirement"
```

---

### Task 10: 定时器与手动同步入口

**Files:**
- Create: `src/modules/sync/sso/sso-sync.scheduler.ts`
- Create: `src/modules/sync/sync.controller.ts`
- Create: `src/modules/sync/dto/run-sync.dto.ts`
- Create: `src/modules/sync/dto/query-sync-run.dto.ts`
- Create: `src/modules/sync/dto/sync-run-response.dto.ts`
- Create: `src/modules/sync/dto/sync-run-page-response.dto.ts`
- Modify: `src/modules/sync/sync.module.ts`
- Modify: `src/modules/sync/sync-run.repository.ts`
- Modify: `prisma/seed.ts`
- Create: `test/sso-sync-admin.e2e-spec.ts`

**Interfaces:**
- Consumes: `SyncService`（Task 9）、`SsoSyncSource`（Task 9）、`ConfigService`、`RedisService`。
- Produces:
  - `POST /sync/sso/run` → `202 { runId: string }`
  - `GET /sync/runs?source=sso&page=&pageSize=` → 分页流水
  - 权限码 `sync:run`

- [ ] **Step 1: 写失败的 e2e**

`test/sso-sync-admin.e2e-spec.ts`：

```ts
it('超管 POST /sync/sso/run → 202 + runId', async () => {
  const tokens = await loginAs(app, admin.username, admin.password);
  const response = await authedAgent(app, tokens.accessToken)
    .post('/sync/sso/run')
    .send({ mode: 'full' })
    .expect(202);
  const body = response.body as ResponseEnvelope<{ runId: string }>;
  expect(body.data.runId).toMatch(/^\d+$/);
});

it('普通用户 POST /sync/sso/run → 403', async () => {
  const tokens = await loginAs(app, normal.username, normal.password);
  await authedAgent(app, tokens.accessToken).post('/sync/sso/run').send({ mode: 'incremental' }).expect(403);
});

it('GET /sync/runs?source=sso → 返回分页流水', async () => {
  const tokens = await loginAs(app, admin.username, admin.password);
  const response = await authedAgent(app, tokens.accessToken)
    .get('/sync/runs?source=sso&page=1&pageSize=10')
    .expect(200);
  const body = response.body as ResponseEnvelope<{ rows: Array<{ source: string; mode: string | null }> }>;
  expect(Array.isArray(body.data.rows)).toBe(true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest --config ./test/jest-e2e.json test/sso-sync-admin.e2e-spec.ts -v`
Expected: FAIL（路由不存在）。

- [ ] **Step 3: 实现调度器**

`SsoSyncScheduler`：

- 构造函数读取 `sso.syncEnabled`、`sso.syncIntervalSeconds`、`sso.syncFullIntervalSeconds`。
- `onApplicationBootstrap`：未启用直接返回；`setInterval(() => void this.tick(), intervalMs)`，`unref()`；`setTimeout(() => void this.tick(), 30_000).unref()` 做首次启动同步。
- `onApplicationShutdown`：清理两个定时器。
- `tick()`：
  1. `const acquired = await redis.client.set(redisKeys.sso.syncLock(), '1', 'EX', 3600, 'NX')`；未拿到直接返回。
  2. `try`：查 `runs.findLastFinishedByMode('sso', 'full')`；无或超过 `fullIntervalSeconds` → `mode='full'`，否则 `'incremental'`。
  3. `await sync.runOnce(source, { mode })`；日志记录 `runId/status/total/failCount`。
  4. `catch` 记 error 日志，不抛。
  5. `finally` `redis.client.del(lockKey)`。

- [ ] **Step 4: 实现控制器**

`sync.controller.ts`：

```ts
@ApiTags('同步')
@Controller('sync')
export class SyncController {
  @Post('sso/run')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('sync:run')
  async runSso(@Body() dto: RunSyncDto): Promise<{ runId: string }> {
    const mode = dto.mode ?? 'incremental';
    const run = await this.sync.startRun(this.source, { mode });
    void this.sync.executeRun(this.source, run, { mode }).catch((error: unknown) => {
      this.logger.error(`手动同步失败：${String(error)}`);
    });
    return { runId: run.id.toString() };
  }

  @Get('runs')
  @RequirePermission('sync:run')
  async listRuns(@Query() query: QuerySyncRunDto): Promise<SyncRunPageResponseDto> {
    return this.runs.findPage(query.source, query.page, query.pageSize);
  }
}
```

`RunSyncDto`：`mode?: 'incremental' | 'full'`（`@IsIn`）。`QuerySyncRunDto`：`source?`、`page`、`pageSize`。

`SyncRunRepository.findPage` 返回 `{ rows, total }`，按 `startedAt desc`；`SyncRunResponseDto` 暴露 `id`（string）、`source`、`mode`、`status`、`startedAt`、`finishedAt`、`total`、`okCount`、`failCount`，**不返回 `detail`**（可能很大），详情走单独接口或后续再加。

`prisma/seed.ts` 增加 `sync:run` 权限行（Task 2 已加，若未加则这里补）。

`sync.module.ts` controllers 增加 `SyncController`，providers 增加 `SsoSyncScheduler`。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx jest --config ./test/jest-e2e.json test/sso-sync-admin.e2e-spec.ts -v`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/modules/sync prisma/seed.ts test/sso-sync-admin.e2e-spec.ts
git commit -m "feat(sync): add sso sync scheduler and admin endpoints"
```

---

### Task 11: 前端新增功能文档

**Files:**
- Create: `docs/前端对接-统一认证登录.md`
- Modify: `docs/前端对接-导师端.md`
- Modify: `docs/前端对接-学生端.md`
- Modify: `docs/手动测试清单.md`

**Interfaces:**
- Consumes: Task 5 的响应字段、Task 6 的 20112、Task 10 的同步接口。

- [ ] **Step 1: 写文档**

`docs/前端对接-统一认证登录.md` 必须包含：

1. 登录流程：`POST /auth/login` → SSO 优先 → 网络不可达回退本地密码；附时序图。
2. 请求示例与响应示例（含 `loginSource`、`ssoUnavailable`、`isDefaultPwd`）。
3. 错误码表 20101–20113，逐条给出前端提示文案。
4. 回退提示条文案与展示条件：`ssoUnavailable === true`。
5. `isDefaultPwd === true` 时提示去统一认证平台改密。
6. SSO 账号不能本地改密（20112），隐藏改密入口（`profile.user.authSource === 'sso'`）。
7. 定时同步影响：姓名/部门可能变化、账号可能被停用（20102）、建议重新拉 `/auth/profile`。
8. 本地账号（`authSource='local'`）不受 SSO 影响。
9. 首次登录自动建号说明（教师默认 mentor、学生默认 student）。
10. 手动同步接口（若前端做运维页）：`POST /sync/sso/run` 返回 202 + `runId`，`GET /sync/runs` 查状态。

更新旧文档：账号表加 `authSource` 说明；登录章节加「统一认证优先」链接；手动测试清单加 SSO 登录/回退/同步用例。

- [ ] **Step 2: 校对链接**

Run: `git diff --check`
Expected: 无输出。

- [ ] **Step 3: 提交**

```bash
git add docs
git commit -m "docs: add sso login frontend guide"
```

---

### Task 12: 全量验证与 OpenAPI 更新

**Files:**
- Modify: `docs/openapi.json`（由脚本生成）

- [ ] **Step 1: 跑 lint**

Run: `npm run lint`
Expected: 0 errors。

- [ ] **Step 2: 跑单元测试**

Run: `npm test`
Expected: 全部 PASS。

- [ ] **Step 3: 重新生成 OpenAPI 快照**

Run: `npm run docs:gen`
Expected: `docs/openapi.json` 更新，包含 20108–20113、登录新字段、`/sync/sso/run`、`/sync/runs`。

- [ ] **Step 4: 跑 e2e**

Run: `npm run test:e2e`
Expected: 全部 PASS（需要本地 MySQL + Redis；测试库由 `.env.test.local` 指定）。`openapi-contract.e2e-spec.ts` 读的是刚生成的快照，必须在它之前跑 `docs:gen`。

- [ ] **Step 5: 检查工作区**

Run: `git status --short`
Expected: 只剩预期文件；没有 `.env`、日志、上传文件。

- [ ] **Step 6: 提交**

```bash
git add docs/openapi.json
git commit -m "chore: regenerate openapi for sso login and sync"
```

---

## Self-Review

- **Spec coverage:** 登录方向 A / 回退 / 错误码 / 自动建号 / 密码同步 / teacher 类型 / 定时同步 / 离场范围 / 根部门 / 前端文档均有对应任务。
- **Type consistency:** `SsoApiError.kind`、`SsoLoginUser`、`SsoProvisionInput`、`SyncRetirementScope`、`findLastUsableStartedAt` 在 Task 3/4/9 之间名称一致。
- **Review Focus:** 5 条都落到具体测试：Task 5 的凭据错误/网络错误用例、Task 9 的离场范围与分页失败用例、Task 7 的 teacher 身份门用例。
- **Known trade-off:** PARTIAL 也推进水位，失败行靠下一次全量重试；`test/sync.e2e-spec.ts` 的 Ruling 25 用例必须按新语义改写，否则会红。
