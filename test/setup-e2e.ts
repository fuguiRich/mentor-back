import { config } from 'dotenv';

// e2e 连接独立的测试库与独立的 Redis db。
// 清空业务表的是**每个套件自己的 beforeAll**——按外键拓扑序显式 deleteMany
// （连接表走 client，四张实体表走 includingDeleted），不是 TRUNCATE。
// 本文件只负责加载环境变量，不建应用、不清库、不造数。
// 批次二的认证用例还会往 Redis 写令牌键。
config({ path: '.env.test.local', quiet: true });

// e2e 专用密钥兜底（R17）。用 `??=` 而不是 `=`：用户在 .env.test.local 里配了就用配的。
// 不去改用户的 .env 文件；生产路径不受影响——validateEnv 仍要求 JWT_SECRET 必须存在且够长。
process.env.JWT_SECRET ??= 'e2e-only-secret-not-used-in-production-0123456789';
