import { Inject, Injectable, HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SysUser } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { compareSync, hashSync } from 'bcryptjs';
import {
  BCRYPT_ROUNDS,
  DUMMY_PASSWORD_HASH,
  LOGIN_MAX_ATTEMPTS,
} from '../../common/constants/auth.constants';
import { ErrorCode } from '../../common/constants/error-code';
import { BusinessException } from '../../common/errors/business.exception';
import { SessionStore } from '../../infra/redis/session-store.service';
import { PermissionService } from '../permission/permission.service';
import { UserService } from '../user/user.service';
import { TokenService } from './token.service';
import { SSO_PROVIDER, type SsoProvider } from './sso/sso.provider';
import {
  SsoApiLoginClient,
  type SsoLoginUser,
} from './sso/sso-api-login.client';
import { SsoApiError } from './sso/sso-error';
import { SsoUserProvisioner } from '../sync/sso/sso-user-provisioner';
import type { AppConfig } from '../../config/configuration';
import type { UserResponseDto } from '../user/dto/user-response.dto';
import type { AuthProfileResponseDto } from './dto/auth-profile.response.dto';
import type { AuthTokensResponseDto } from './dto/auth-tokens.response.dto';
import type { ChangePasswordDto } from './dto/change-password.dto';
import type { LoginDto } from './dto/login.dto';
import type { SsoAuthorizeResponseDto } from './dto/sso-authorize.response.dto';
import type { SsoCallbackQueryDto } from './dto/sso-callback.query.dto';

/** 登出需要的三样东西：身份、access 令牌的 jti 与它的 exp（epoch 秒） */
export interface LogoutInput {
  userId: bigint;
  accessJti: string;
  accessExpiresAt: number;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UserService,
    private readonly permissions: PermissionService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionStore,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(SSO_PROVIDER) private readonly sso: SsoProvider,
    private readonly ssoClient: SsoApiLoginClient,
    private readonly provisioner: SsoUserProvisioner,
  ) {}

  /**
   * 登录入口。分流规则（design D1）：
   *
   * - `authSource = local`：本地账号（超管 / 管理员），永远走 bcrypt。
   * - `SSO_LOGIN_ENABLED = false`：所有账号都走本地 bcrypt（应急回滚）。
   * - 其余：先调 SSO api-login；只有网络不可达才回退本地密码。
   */
  async login(dto: LoginDto): Promise<AuthTokensResponseDto> {
    const user = await this.users.findByUsername(dto.username);

    if (user !== null && user.authSource === 'local') {
      return this.localLogin(dto, user);
    }
    if (!this.config.get('sso.loginEnabled', { infer: true })) {
      return this.localLogin(dto, user);
    }
    return this.ssoLogin(dto, user);
  }

  private async localLogin(
    dto: LoginDto,
    user: SysUser | null,
  ): Promise<AuthTokensResponseDto> {
    // 锁定判定放最前：被锁的账号连一次口令校验都不做，既省 CPU，
    // 也让「被锁定」只有一种失败外观（不会先报一次密码错再报锁定）。
    await this.assertNotLocked(dto.username);

    // 防用户名枚举（spec 第 7 节登录流程第 2 步）：用户不存在时**仍跑一次 bcrypt**
    // （比对哨兵哈希），让两条路径的耗时同阶。
    // compareSync 必须**无条件**执行——写成 `user !== null && compareSync(...)`
    // 会在短路后跳过哈希运算，省下来的那一次运算就是计时侧信道，等于没做。
    const candidateHash = user === null ? DUMMY_PASSWORD_HASH : user.password;
    const passwordMatched = compareSync(dto.password, candidateHash);

    // R18：口令先于停用判定。顺序反过来会让「账号已停用」变成存在性侧信道。
    if (user === null || !passwordMatched) {
      const attempts = await this.sessions.registerLoginFailure(dto.username);
      this.logger.debug(`登录失败：${dto.username}（窗口内第 ${attempts} 次）`);
      if (attempts >= LOGIN_MAX_ATTEMPTS) {
        throw this.loginLocked();
      }
      throw this.credentialsInvalid();
    }

    if (user.status !== 1) {
      // 走到这里口令已经正确——「该用户名存在」不再构成增量泄露
      throw this.accountDisabled();
    }

    await this.sessions.clearLoginFailures(dto.username);
    await this.users.recordLogin(user.id);

    return this.issueTokens(user.id, user.username, user.isSuperAdmin, {
      loginSource: 'local',
      ssoUnavailable: false,
    });
  }

  /**
   * SSO-first 登录。成功时回写本地信息与密码；失败按 `SsoApiError.kind` 分流。
   *
   * **只有 `unavailable` 才可能回退本地密码**：SSO 明确说密码错/锁定/应用禁用时
   * 回退等于绕过 SSO 的密码策略与锁定。
   */
  private async ssoLogin(
    dto: LoginDto,
    existing: SysUser | null,
  ): Promise<AuthTokensResponseDto> {
    let ssoUser: SsoLoginUser;
    try {
      const result = await this.ssoClient.login(dto.username, dto.password);
      ssoUser = result.user;
    } catch (error: unknown) {
      if (!(error instanceof SsoApiError)) {
        throw error;
      }
      return this.handleSsoFailure(error, dto, existing);
    }

    return this.completeSsoLogin(dto, existing, ssoUser);
  }

  private async completeSsoLogin(
    dto: LoginDto,
    existing: SysUser | null,
    ssoUser: SsoLoginUser,
  ): Promise<AuthTokensResponseDto> {
    const userType = ssoUser.userType;
    if (userType !== 'teacher' && userType !== 'student') {
      // 统一认证通过，但本系统不自动为 admin / 未知类型建号
      throw this.ssoUserUnknown();
    }

    let user = existing;
    if (user === null) {
      const provisioned = await this.provisioner.ensureUser({
        login: ssoUser.userName,
        realName: ssoUser.nickName,
        userType,
        deptId: ssoUser.deptId,
        deptName: ssoUser.deptName,
        passwordHash: hashSync(dto.password, BCRYPT_ROUNDS),
      });
      user = await this.users.findById(provisioned.userId);
      if (user === null) {
        throw this.ssoProvisionFailed();
      }
    }

    if (user.status !== 1) {
      throw this.accountDisabled();
    }

    const deptId = await this.provisioner.resolveDeptId(
      ssoUser.deptId,
      ssoUser.deptName,
    );
    const passwordHash = compareSync(dto.password, user.password)
      ? null
      : hashSync(dto.password, BCRYPT_ROUNDS);

    await this.users.syncSsoProfile(user.id, {
      realName:
        ssoUser.nickName.trim() === '' ? user.realName : ssoUser.nickName,
      deptId,
      passwordHash,
    });

    await this.sessions.clearLoginFailures(dto.username);
    await this.users.recordLogin(user.id);

    return this.issueTokens(user.id, user.username, user.isSuperAdmin, {
      loginSource: 'sso',
      ssoUnavailable: false,
      isDefaultPwd: ssoUser.isDefaultPwd,
    });
  }

  private async handleSsoFailure(
    error: SsoApiError,
    dto: LoginDto,
    existing: SysUser | null,
  ): Promise<AuthTokensResponseDto> {
    switch (error.kind) {
      case 'credentials':
        throw this.credentialsInvalid();
      case 'locked':
        throw this.loginLocked();
      case 'rate_limited':
        throw this.ssoRateLimited();
      case 'config':
        throw this.ssoConfigInvalid();
      case 'invalid':
        throw this.ssoResponseInvalid();
      case 'unavailable':
        break;
    }

    const fallbackEnabled = this.config.get('sso.fallbackEnabled', {
      infer: true,
    });
    const fallbackOn5xx = this.config.get('sso.fallbackOn5xx', {
      infer: true,
    });
    const is5xx = error.httpStatus !== null && error.httpStatus >= 500;

    if (!fallbackEnabled || (is5xx && !fallbackOn5xx)) {
      throw this.ssoUnavailable();
    }

    return this.localFallback(dto, existing);
  }

  /** 仅网络不可达时走到这里；本地锁定只约束这条路径，不阻止 SSO 正常登录 */
  private async localFallback(
    dto: LoginDto,
    existing: SysUser | null,
  ): Promise<AuthTokensResponseDto> {
    if (existing === null) {
      throw this.ssoUnavailable();
    }

    await this.assertNotLocked(dto.username);

    if (existing.status !== 1) {
      throw this.accountDisabled();
    }

    if (!compareSync(dto.password, existing.password)) {
      const attempts = await this.sessions.registerLoginFailure(dto.username);
      if (attempts >= LOGIN_MAX_ATTEMPTS) {
        throw this.loginLocked();
      }
      throw this.credentialsInvalid();
    }

    await this.sessions.clearLoginFailures(dto.username);
    await this.users.recordLogin(existing.id);

    return this.issueTokens(
      existing.id,
      existing.username,
      existing.isSuperAdmin,
      { loginSource: 'local-fallback', ssoUnavailable: true },
    );
  }

  /**
   * 签发双令牌。
   *
   * sv（会话版本）**跨登录稳定**，登录时不重置：`ensureSessionVersion` 用 SET NX 播种
   * Date.now() 时间戳，`revokeSessions` 写 max(Date.now(), current+1)，两者都只增不减。
   * 若登录时把它重置回种子，先前被 revokeSessions 推高的旧令牌会**复活**——
   * 老令牌的 sv 重新匹配上，「踢下线」变成「踢下线，直到他再登一次」。
   */
  private async issueTokens(
    userId: bigint,
    username: string,
    isSuperAdmin: boolean,
    extras: Pick<
      AuthTokensResponseDto,
      'loginSource' | 'ssoUnavailable' | 'isDefaultPwd'
    > = {},
  ): Promise<AuthTokensResponseDto> {
    const sv = await this.sessions.ensureSessionVersion(userId);

    // 权限码在登录时**重算并覆盖**，不走 cache-aside 的 load()：
    // 登录是「我此刻拥有什么权限」的权威时刻，取上一个会话残留的缓存
    // 就等于把权限变更的生效时机交给了 TTL。
    const codes = await this.permissions.findCodesByUserId(userId);
    await this.sessions.setPermissions(userId, codes);

    const access = await this.tokens.signAccess({
      userId,
      username,
      sv,
      isSuperAdmin,
    });
    const refresh = await this.tokens.signRefresh({ userId, sv });
    await this.sessions.storeRefreshToken(
      userId,
      refresh.jti,
      refresh.expiresIn,
    );

    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      expiresIn: access.expiresIn,
      ...extras,
    };
  }

  async refresh(refreshToken: string): Promise<AuthTokensResponseDto> {
    const verified = this.tokens.verifyRefresh(refreshToken);
    if (!verified.ok) {
      throw this.refreshInvalid();
    }

    const { sub, sv, jti } = verified.payload;
    const userId = this.toUserId(sub);

    // 白名单：logout 会把 jti 摘掉，「登出后还能不能换新 access」由这一行决定。
    // 顺带校验归属：白名单值是持有者 userId，被换过的条目不该给自己发令牌。
    const owner = await this.sessions.getRefreshTokenOwner(jti);
    if (owner === null || owner !== userId.toString()) {
      throw this.refreshInvalid();
    }

    // R3：refresh 载荷里的 sv 必须仍与当前会话版本一致。
    // 少了这一条，改密码 / 停用 / 踢人之后，旧 refresh 还能换出一枚**合法** access
    // ——新 access 带的是签发时的新 sv，校验照过。会话版本机制被整条绕过，且不报错。
    const currentSv = await this.sessions.getSessionVersion(userId);
    if (currentSv === null || currentSv !== sv) {
      throw this.refreshInvalid();
    }

    // 续期 sv 键的 TTL（ledger 发现 10）：refresh 成功一次就刷新一次吊销状态的寿命，
    // 活跃用户的会话才不会被钉死在 7 天的硬天花板上。
    await this.sessions.touchSessionVersion(userId);

    const user = await this.users.findById(userId);
    if (user === null || user.status !== 1) {
      // 账号已被删或停用，旧 refresh 不该继续换牌
      throw this.refreshInvalid();
    }

    // 决策 6：refresh 不轮换。原令牌原样返回，白名单条目不动——
    // refresh 的生命周期从登录那刻起算满 7 天，刷新不延长它。
    const access = await this.tokens.signAccess({
      userId,
      username: user.username,
      sv: currentSv,
      isSuperAdmin: user.isSuperAdmin,
    });

    return {
      accessToken: access.token,
      refreshToken,
      expiresIn: access.expiresIn,
    };
  }

  async logout(input: LogoutInput): Promise<void> {
    // access 进黑名单，TTL 取剩余寿命：令牌本来就活 2 小时，
    // 黑名单条目不必比它更久（过期令牌在守卫里本来就验不过，blacklistAccessToken
    // 内部还挡了 TTL<=0，免得把「什么都不用做」变成一次 EX 0 的 500）。
    const nowSeconds = Math.floor(Date.now() / 1000);
    await this.sessions.blacklistAccessToken(
      input.accessJti,
      input.accessExpiresAt - nowSeconds,
    );

    // refresh 出白名单。**必须**校验归属——不校验的话，任何登录者都能把别人的
    // jti 递进来，等于「替别人登出」。归属不对时静默跳过，不删别人的条目。
    // 登出始终返回 204：401 不应有副作用，且「这枚 refresh 是否有效」不该成为探测口。
    const verified = this.tokens.verifyRefresh(input.refreshToken);
    if (!verified.ok) {
      return;
    }

    const owner = await this.sessions.getRefreshTokenOwner(
      verified.payload.jti,
    );
    if (owner === null || owner !== input.userId.toString()) {
      return; // 不在白名单或不属于当前用户：跳过，不删别人的条目
    }

    await this.sessions.removeRefreshToken(verified.payload.jti);
  }

  /**
   * 当前登录者的画像：我是谁 + 我能做什么 + 侧边栏摆什么。
   *
   * 超管的 permissions 是「系统里全部启用的权限码」而不是他角色上的码：
   * 守卫对超管跳过全部权限检查，返回一个可能为空的角色码集合会让前端把按钮全藏起来，
   * 与"超管能做任何事"矛盾。菜单树同理——拿这个全集去裁，超管自然看到整棵树。
   */
  async getProfile(userId: bigint): Promise<AuthProfileResponseDto> {
    const user = await this.users.findOne(userId);

    const codes = user.isSuperAdmin
      ? await this.permissions.findAllCodes()
      : await this.permissions.findCodesByUserId(userId);
    const menus = await this.permissions.findMenuTreeByCodes(codes);

    return { user, permissions: [...codes], menus };
  }

  /**
   * 本人改密码。旧密码必须校验（这是本人改密与管理员重置的唯一差别）。
   *
   * 改完会作废该用户**全部**已签发令牌（R14）——包括调用者自己这一枚。
   * 这是故意的：改密码的动因常常就是"我怀疑密码泄露了"，把自己也踢下线才对。
   * Swagger 描述里写明了这一点，前端改完密码要引导重新登录。
   */
  async changePassword(
    userId: bigint,
    dto: ChangePasswordDto,
  ): Promise<UserResponseDto> {
    const user = await this.users.findById(userId);
    if (user === null || user.status !== 1) {
      // 令牌还活着但账号已经没了/被停了：会话不成立，回登录态失效的同一句话
      throw this.sessionNoLongerValid();
    }

    if (user.authSource === 'sso') {
      throw new BusinessException(
        ErrorCode.AUTH_SSO_PASSWORD_MANAGED,
        '统一认证账号请在统一认证平台修改密码',
        HttpStatus.FORBIDDEN,
      );
    }

    if (!compareSync(dto.oldPassword, user.password)) {
      throw this.passwordMismatch();
    }

    return this.users.changeOwnPassword(
      userId,
      hashSync(dto.newPassword, BCRYPT_ROUNDS),
    );
  }

  /**
   * 生成带 state 的学校认证页 URL。state 先落 Redis 再返回——
   * 顺序反过来的话，用户可能在 state 入库之前就回来了（回调报"state 无效"，
   * 而 URL 明明是刚拿到的，这种时序问题极难排）。
   */
  async ssoAuthorize(): Promise<SsoAuthorizeResponseDto> {
    const state = randomBytes(32).toString('base64url');
    const ttlSeconds = this.config.get('sso.stateTtlSeconds', { infer: true });
    await this.sessions.saveSsoState(state, ttlSeconds);

    return { authorizeUrl: this.sso.buildAuthorizeUrl(state) };
  }

  /**
   * 统一认证回调。返回双令牌（与 POST /auth/login 同形），**不做 302**（R11）。
   *
   * 三条失败各自对应一个码，但对外都不解释细节：
   *   state 不对/已用过/票据换不出工号 → 20106（把三种并成一种，见 Step 1）
   *   工号拿到了但本地没这个账号       → 20107（spec 第 7 节：**不自动建号**）
   *   账号在但已停用                   → 20102（与本地登录同形）
   */
  async ssoCallback(
    query: SsoCallbackQueryDto,
  ): Promise<AuthTokensResponseDto> {
    if (query.error !== undefined && query.error !== '') {
      this.logger.warn(`统一认证被上游拒绝：${query.error}`);
      throw this.ssoStateInvalid();
    }

    // 一次性消费：用过即删（SessionStore.consumeSsoState），票据重放的第一道闸
    const stateOk = await this.sessions.consumeSsoState(query.state);
    if (!stateOk) {
      throw this.ssoStateInvalid();
    }

    // ticket 现在是可选的（上游带 error 时根本没有它）；没带就当空票据处理，
    // 与「换不出工号」同归 20106，不给未定义留一条 500 的缝。
    const employeeNo = await this.sso.exchangeTicket(query.ticket ?? '');
    if (employeeNo === null) {
      throw this.ssoStateInvalid();
    }

    const user = await this.users.findByEmployeeNo(employeeNo);
    if (user === null) {
      // 认证通过了，但本系统没有这个账号。**不自动建号**：谁能进这个系统
      // 是管理员的决定，不是"他在学校有工号"的副作用。
      this.logger.warn(`统一认证通过但本地无账号：工号 ${employeeNo}`);
      throw this.ssoUserUnknown();
    }

    if (user.status !== 1) {
      throw this.accountDisabled();
    }

    await this.users.recordLogin(user.id);
    return this.issueTokens(user.id, user.username, user.isSuperAdmin);
  }

  private async assertNotLocked(username: string): Promise<void> {
    const failures = await this.sessions.getLoginFailures(username);
    if (failures >= LOGIN_MAX_ATTEMPTS) {
      this.logger.debug(`登录被锁定：${username}（窗口内 ${failures} 次）`);
      throw this.loginLocked();
    }
  }

  private toUserId(sub: string): bigint {
    try {
      return BigInt(sub);
    } catch {
      throw this.refreshInvalid();
    }
  }

  // 「登录失败」三兄弟只此一处定义：错误码/文案/状态码改动时不会漏掉某个入口
  private credentialsInvalid(): BusinessException {
    return new BusinessException(
      ErrorCode.AUTH_CREDENTIALS_INVALID,
      '用户名或密码错误',
      HttpStatus.UNAUTHORIZED,
    );
  }

  private accountDisabled(): BusinessException {
    return new BusinessException(
      ErrorCode.AUTH_ACCOUNT_DISABLED,
      '账号已停用，请联系管理员',
      HttpStatus.UNAUTHORIZED,
    );
  }

  private loginLocked(): BusinessException {
    return new BusinessException(
      ErrorCode.AUTH_LOGIN_LOCKED,
      '登录失败次数过多，请稍后再试',
      HttpStatus.UNAUTHORIZED,
    );
  }

  private refreshInvalid(): BusinessException {
    return new BusinessException(
      ErrorCode.AUTH_REFRESH_INVALID,
      '登录状态已失效，请重新登录',
      HttpStatus.UNAUTHORIZED,
    );
  }

  private passwordMismatch(): BusinessException {
    return new BusinessException(
      ErrorCode.AUTH_PASSWORD_MISMATCH,
      '原密码错误',
      HttpStatus.BAD_REQUEST,
    );
  }

  private ssoStateInvalid(): BusinessException {
    return new BusinessException(
      ErrorCode.AUTH_SSO_STATE_INVALID,
      '统一认证未通过，请重新发起登录',
      HttpStatus.BAD_REQUEST,
    );
  }

  private ssoUserUnknown(): BusinessException {
    return new BusinessException(
      ErrorCode.AUTH_SSO_USER_UNKNOWN,
      '统一认证已通过，但本系统没有对应账号，请联系管理员',
      HttpStatus.FORBIDDEN,
    );
  }

  private ssoUnavailable(): BusinessException {
    return new BusinessException(
      ErrorCode.AUTH_SSO_UNAVAILABLE,
      '统一认证暂不可用，请稍后重试',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  private ssoConfigInvalid(): BusinessException {
    return new BusinessException(
      ErrorCode.AUTH_SSO_CONFIG_INVALID,
      '统一认证配置异常，请联系管理员',
      HttpStatus.BAD_GATEWAY,
    );
  }

  private ssoRateLimited(): BusinessException {
    return new BusinessException(
      ErrorCode.AUTH_SSO_RATE_LIMITED,
      '统一认证请求过于频繁，请稍后重试',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private ssoResponseInvalid(): BusinessException {
    return new BusinessException(
      ErrorCode.AUTH_SSO_RESPONSE_INVALID,
      '统一认证返回异常，请稍后重试',
      HttpStatus.BAD_GATEWAY,
    );
  }

  private ssoProvisionFailed(): BusinessException {
    return new BusinessException(
      ErrorCode.AUTH_SSO_PROVISION_FAILED,
      '统一认证已通过，但本地账号创建失败，请联系管理员',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  /**
   * 「令牌还成立，但账号已经不成立」——软删后残留的旧令牌、或刚被停用的账号。
   * 用 20104 而不是 21101：调用者是**会话持有者**，他需要知道的是"你的登录态没了、
   * 去重新登录"，不是"这个用户不存在"（那句话对本人没有操作价值）。
   * 20104 的成员名叫 AUTH_REFRESH_INVALID 是历史遗留（它最早只在刷新链路上用），
   * **对外契约是它的文案**「登录状态已失效，请重新登录」，两个入口用同一句话。
   */
  private sessionNoLongerValid(): BusinessException {
    return new BusinessException(
      ErrorCode.AUTH_REFRESH_INVALID,
      '登录状态已失效，请重新登录',
      HttpStatus.UNAUTHORIZED,
    );
  }
}
