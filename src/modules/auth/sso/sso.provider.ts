/**
 * 学校统一认证的抽象。唯一职责是「用票据换一个稳定的用户唯一标识（工号）」。
 *
 * 为什么只抽这一件事：拿到工号之后的流程（映射本地用户、签发本地双令牌）与
 * 本地登录完全同构，spec 第 7 节要求**不**建立第二套会话——权限守卫、会话版本、
 * 权限缓存因此只有一条代码路径，不会出现「本地登录的能踢下线、SSO 登录的踢不掉」。
 *
 * 学校的协议（CAS / OAuth2 / OIDC）尚未确定（spec 第 10 节），所以换实现时
 * **不动调用方**：AuthService 只认这个接口。
 */
export interface SsoProvider {
  /** 'mock' | 'oidc'，只用于日志与排错 */
  readonly name: string;

  /** 生成学校认证页的跳转 URL，state 必须原样带上（防 CSRF） */
  buildAuthorizeUrl(state: string): string;

  /**
   * 用回调带回来的票据换工号。
   * 换不出来（票据无效、端点错误、缺声明）返回 null——**不抛**：
   * 对调用者这三种没有区分价值，统一回 20106；细节由实现内部记日志。
   */
  exchangeTicket(ticket: string): Promise<string | null>;
}

/** 注入令牌。用字符串而非 class token：注入的是接口，不是某个实现 */
export const SSO_PROVIDER = 'SSO_PROVIDER';
