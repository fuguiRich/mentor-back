/**
 * 认证相关的共享常量。
 *
 * BCRYPT_ROUNDS 只此一处定义：prisma/seed.ts（播种初始超管）、认证模块的登录校验、
 * e2e 造数三处都从这里取。三处各写一份的后果不是报错，而是"密码的 cost 悄悄分成
 * 几档"——bcrypt 照样校验通过，没有任何机制会说话。
 */
export const BCRYPT_ROUNDS = 10;

/** 登录失败锁定：15 分钟内 5 次即锁定（spec 决策 8） */
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_LOCK_SECONDS = 15 * 60;

/**
 * 权限码缓存的存活时间。它只管**缓存**的自愈上界，与会话/令牌寿命无关——
 * 权限码丢了可以从库里重算，所以越短越新鲜。不要拿它当 sv 键的 TTL。
 */
export const PERMISSIONS_CACHE_TTL_SECONDS = 30 * 60;

/**
 * 会话版本（sv）键的存活时间。它不是缓存，是**吊销状态**：
 * 键消失 = 吊销记录消失 = 旧令牌复活。所以它的寿命必须 ≥ refresh 令牌寿命
 * （refresh 载荷里带 sv，7 天内随时可能来换新令牌），否则会出现"我明明改过
 * 密码"的复活窗口。与 JWT_REFRESH_TTL_SECONDS 的默认值一致；改 refresh 寿命
 * 时这里要一起改（R22）。
 */
export const SESSION_VERSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * 用户名不存在时用来做等时比对的哨兵哈希（spec 决策 8）。
 *
 * 必须是**真实的** bcrypt 哈希，且 cost 与 BCRYPT_ROUNDS 一致：否则
 * "用户不存在"与"密码错误"两条路径耗时不同，防用户名枚举就成了摆设。
 * 单测固定了 getRounds(DUMMY_PASSWORD_HASH) === BCRYPT_ROUNDS——
 * 改上面的 BCRYPT_ROUNDS 而忘了换这段字符串，测试会红。
 */
export const DUMMY_PASSWORD_HASH =
  '$2b$10$DhXpqN3cVWLZYw/wjTX.BO3bjlHu6TrUGGW2Gw6zPwz3Y0lnJ1Bu6';

/** 明文口令长度上下限。上限 72 是 bcrypt 的字节上限（再长会被**静默**截断，
 *  第 73 个字符起不参与比对——两口不同的长口令可能互认，且没有任何东西会说话）。
 *  在 DTO 层就把它挡掉，而不是让截断发生。登录、改密、重置密码三处共用这一对常量。 */
export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 72;
