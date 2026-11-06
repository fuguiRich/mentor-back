import type { ConfigService } from '@nestjs/config';
import type { SysUser } from '@prisma/client';
import { compareSync, hashSync } from 'bcryptjs';
import { BCRYPT_ROUNDS } from '../../common/constants/auth.constants';
import { ErrorCode } from '../../common/constants/error-code';
import type { SessionStore } from '../../infra/redis/session-store.service';
import type { PermissionTreeResponseDto } from '../permission/dto/permission-tree-response.dto';
import type { PermissionService } from '../permission/permission.service';
import type { UserDetailResponseDto } from '../user/dto/user-detail-response.dto';
import type { UserResponseDto } from '../user/dto/user-response.dto';
import type { UserService } from '../user/user.service';
import type { AppConfig } from '../../config/configuration';
import { AuthService } from './auth.service';
import type { TokenService } from './token.service';
import type { SsoProvider } from './sso/sso.provider';
import { SsoApiError } from './sso/sso-error';
import type { SsoApiLoginClient } from './sso/sso-api-login.client';
import type { SsoUserProvisioner } from '../sync/sso/sso-user-provisioner';

const OLD_PASSWORD = 'OldPassw0rd!';
const NEW_PASSWORD = 'NewPassw0rd!';

function sysUser(overrides: Partial<SysUser> = {}): SysUser {
  return {
    id: 1n,
    username: 'alice',
    password: hashSync(OLD_PASSWORD, BCRYPT_ROUNDS),
    realName: 'Alice',
    employeeNo: 'E001',
    mobile: null,
    deptId: 1n,
    status: 1,
    isSuperAdmin: false,
    authSource: 'local',
    lastLoginAt: null,
    createdAt: new Date('2026-10-14T00:00:00.000Z'),
    updatedAt: new Date('2026-10-14T00:00:00.000Z'),
    createdBy: 0n,
    updatedBy: 0n,
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  };
}

function userDetail(
  overrides: Partial<UserDetailResponseDto> = {},
): UserDetailResponseDto {
  return {
    id: '1',
    username: 'alice',
    realName: 'Alice',
    employeeNo: 'E001',
    mobile: null,
    deptId: '1',
    deptName: '总公司',
    status: 1,
    isSuperAdmin: false,
    authSource: 'local',
    lastLoginAt: null,
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-14T00:00:00.000Z',
    createdBy: '0',
    updatedBy: '0',
    roleIds: [],
    ...overrides,
  };
}

function userResponse(
  overrides: Partial<UserResponseDto> = {},
): UserResponseDto {
  return {
    id: '1',
    username: 'alice',
    realName: 'Alice',
    employeeNo: 'E001',
    mobile: null,
    deptId: '1',
    deptName: '总公司',
    status: 1,
    isSuperAdmin: false,
    authSource: 'local',
    lastLoginAt: null,
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-14T00:00:00.000Z',
    createdBy: '0',
    updatedBy: '0',
    ...overrides,
  };
}

const emptyMenus: PermissionTreeResponseDto[] = [];

interface StubBag {
  // users
  findById: jest.Mock;
  findOne: jest.Mock;
  findByEmployeeNo: jest.Mock;
  findByUsername: jest.Mock;
  recordLogin: jest.Mock;
  changeOwnPassword: jest.Mock;
  syncSsoProfile: jest.Mock;
  // permissions
  findCodesByUserId: jest.Mock;
  findAllCodes: jest.Mock;
  findMenuTreeByCodes: jest.Mock;
  // tokens
  signAccess: jest.Mock;
  signRefresh: jest.Mock;
  // sessions
  ensureSessionVersion: jest.Mock;
  setPermissions: jest.Mock;
  storeRefreshToken: jest.Mock;
  saveSsoState: jest.Mock;
  consumeSsoState: jest.Mock;
  getLoginFailures: jest.Mock;
  registerLoginFailure: jest.Mock;
  clearLoginFailures: jest.Mock;
  // config + sso
  configGet: jest.Mock;
  buildAuthorizeUrl: jest.Mock;
  exchangeTicket: jest.Mock;
  ssoLogin: jest.Mock;
  provisionUser: jest.Mock;
  resolveDeptId: jest.Mock;
}

/**
 * 桩全部走 jest.fn()：用例里要断言「某个方法**没有**被调用」，
 * 手写 call-log 数组做这件事既啰嗦又容易漏记。
 */
function buildService(
  overrides: Partial<Record<keyof StubBag, unknown>> = {},
): { service: AuthService; stubs: StubBag } {
  const stubs: StubBag = {
    findById: jest.fn().mockResolvedValue(sysUser()),
    findOne: jest.fn().mockResolvedValue(userDetail()),
    findByEmployeeNo: jest.fn().mockResolvedValue(sysUser()),
    findByUsername: jest.fn().mockResolvedValue(sysUser()),
    recordLogin: jest.fn().mockResolvedValue(undefined),
    changeOwnPassword: jest.fn().mockResolvedValue(userResponse()),
    syncSsoProfile: jest.fn().mockResolvedValue(undefined),

    findCodesByUserId: jest.fn().mockResolvedValue(['user:list']),
    findAllCodes: jest.fn().mockResolvedValue(['user:list', 'role:list']),
    findMenuTreeByCodes: jest.fn().mockResolvedValue(emptyMenus),

    signAccess: jest.fn().mockResolvedValue({
      token: 'access-token',
      jti: 'access-jti',
      expiresIn: 7200,
    }),
    signRefresh: jest.fn().mockResolvedValue({
      token: 'refresh-token',
      jti: 'refresh-jti',
      expiresIn: 604800,
    }),

    ensureSessionVersion: jest.fn().mockResolvedValue(1),
    setPermissions: jest.fn().mockResolvedValue(undefined),
    storeRefreshToken: jest.fn().mockResolvedValue(undefined),
    saveSsoState: jest.fn().mockResolvedValue(undefined),
    consumeSsoState: jest.fn().mockResolvedValue(true),

    getLoginFailures: jest.fn().mockResolvedValue(0),
    registerLoginFailure: jest.fn().mockResolvedValue(1),
    clearLoginFailures: jest.fn().mockResolvedValue(undefined),

    configGet: jest.fn((key: string) => {
      const map: Record<string, unknown> = {
        'sso.stateTtlSeconds': 300,
        'sso.loginEnabled': true,
        'sso.fallbackEnabled': true,
        'sso.fallbackOn5xx': false,
      };
      return map[key];
    }),
    buildAuthorizeUrl: jest.fn(
      (state: string) => `https://auth.example.edu/login?state=${state}`,
    ),
    exchangeTicket: jest.fn().mockResolvedValue('E001'),
    ssoLogin: jest.fn().mockResolvedValue({
      user: {
        userName: 'E001',
        nickName: 'Alice',
        userType: 'teacher',
        deptId: '10',
        deptName: '计算机学院',
        isDefaultPwd: false,
      },
    }),
    provisionUser: jest.fn().mockResolvedValue({ userId: 1n }),
    resolveDeptId: jest.fn().mockResolvedValue(1n),
  };

  for (const [key, value] of Object.entries(overrides)) {
    (stubs as unknown as Record<string, unknown>)[key] = value;
  }

  const users = {
    findById: stubs.findById,
    findOne: stubs.findOne,
    findByEmployeeNo: stubs.findByEmployeeNo,
    findByUsername: stubs.findByUsername,
    recordLogin: stubs.recordLogin,
    changeOwnPassword: stubs.changeOwnPassword,
    syncSsoProfile: stubs.syncSsoProfile,
    findPersonTypeByUsername: jest.fn().mockResolvedValue('teacher'),
    findPersonProfileByUsername: jest.fn().mockResolvedValue({
      personType: 'teacher',
      major: '软件工程',
      className: '软工 2023-1 班',
      orgUnitName: '软件学院',
    }),
  } as unknown as UserService;

  const permissions = {
    findCodesByUserId: stubs.findCodesByUserId,
    findAllCodes: stubs.findAllCodes,
    findMenuTreeByCodes: stubs.findMenuTreeByCodes,
  } as unknown as PermissionService;

  const tokens = {
    signAccess: stubs.signAccess,
    signRefresh: stubs.signRefresh,
  } as unknown as TokenService;

  const sessions = {
    ensureSessionVersion: stubs.ensureSessionVersion,
    setPermissions: stubs.setPermissions,
    storeRefreshToken: stubs.storeRefreshToken,
    saveSsoState: stubs.saveSsoState,
    consumeSsoState: stubs.consumeSsoState,
    getLoginFailures: stubs.getLoginFailures,
    registerLoginFailure: stubs.registerLoginFailure,
    clearLoginFailures: stubs.clearLoginFailures,
  } as unknown as SessionStore;

  const config = {
    get: stubs.configGet,
  } as unknown as ConfigService<AppConfig, true>;

  const sso = {
    name: 'mock',
    buildAuthorizeUrl: stubs.buildAuthorizeUrl,
    exchangeTicket: stubs.exchangeTicket,
  } as unknown as SsoProvider;

  const ssoClient = {
    login: stubs.ssoLogin,
  } as unknown as SsoApiLoginClient;

  const provisioner = {
    ensureUser: stubs.provisionUser,
    resolveDeptId: stubs.resolveDeptId,
  } as unknown as SsoUserProvisioner;

  return {
    service: new AuthService(
      users,
      permissions,
      tokens,
      sessions,
      config,
      sso,
      ssoClient,
      provisioner,
    ),
    stubs,
  };
}

describe('AuthService 收尾四接口（profile / 改密 / 统一认证）', () => {
  describe('getProfile', () => {
    it('1. 非超管：permissions 来自 findCodesByUserId、menus 来自 findMenuTreeByCodes、user 来自 findOne', async () => {
      const menus = emptyMenus;
      const detail = userDetail({ isSuperAdmin: false, roleIds: ['2'] });
      const { service, stubs } = buildService({
        findOne: jest.fn().mockResolvedValue(detail),
        findCodesByUserId: jest.fn().mockResolvedValue(['user:list']),
        findMenuTreeByCodes: jest.fn().mockResolvedValue(menus),
      });

      const result = await service.getProfile(1n);

      expect(result.user).toMatchObject(detail);
      expect(result.user.personType).toBe('teacher');
      expect(result.user.mentorType).toBe('internal');
      expect(result.user.major).toBe('软件工程');
      expect(result.user.className).toBe('软工 2023-1 班');
      expect(result.user.orgUnitName).toBe('软件学院');
      expect(result.permissions).toEqual(['user:list']);
      expect(result.menus).toBe(menus);
      expect(stubs.findCodesByUserId).toHaveBeenCalledWith(1n);
      // 传给 findMenuTreeByCodes 的就是 findCodesByUserId 的结果
      expect(stubs.findMenuTreeByCodes).toHaveBeenCalledWith(['user:list']);
    });

    it('2. 超管：不走 findCodesByUserId，改走 findAllCodes', async () => {
      const { service, stubs } = buildService({
        findOne: jest
          .fn()
          .mockResolvedValue(userDetail({ isSuperAdmin: true })),
        // 被调用即抛——超管不该走角色上的码
        findCodesByUserId: jest.fn().mockRejectedValue(new Error('不该被调用')),
        findAllCodes: jest.fn().mockResolvedValue(['user:list', 'role:list']),
      });

      const result = await service.getProfile(1n);

      expect(stubs.findCodesByUserId).not.toHaveBeenCalled();
      expect(stubs.findAllCodes).toHaveBeenCalled();
      expect(result.permissions).toEqual(['user:list', 'role:list']);
    });
  });

  describe('changePassword', () => {
    it('3. 用户不存在 → 20104；status !== 1 → 20104', async () => {
      const gone = buildService({
        findById: jest.fn().mockResolvedValue(null),
      });
      await expect(
        gone.service.changePassword(1n, {
          oldPassword: OLD_PASSWORD,
          newPassword: NEW_PASSWORD,
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.AUTH_REFRESH_INVALID },
      });

      const disabled = buildService({
        findById: jest.fn().mockResolvedValue(sysUser({ status: 0 })),
      });
      await expect(
        disabled.service.changePassword(1n, {
          oldPassword: OLD_PASSWORD,
          newPassword: NEW_PASSWORD,
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.AUTH_REFRESH_INVALID },
      });
    });

    it('4. 旧密码不匹配 → 20105，且 changeOwnPassword 没被调用', async () => {
      const { service, stubs } = buildService();

      await expect(
        service.changePassword(1n, {
          oldPassword: 'NotTheOldOne!',
          newPassword: NEW_PASSWORD,
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.AUTH_PASSWORD_MISMATCH },
      });
      expect(stubs.changeOwnPassword).not.toHaveBeenCalled();
    });

    it('SSO 账号改密 → 403 / 20112', async () => {
      const { service } = buildService({
        findById: jest.fn().mockResolvedValue(sysUser({ authSource: 'sso' })),
      });

      await expect(
        service.changePassword(1n, {
          oldPassword: OLD_PASSWORD,
          newPassword: NEW_PASSWORD,
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.AUTH_SSO_PASSWORD_MANAGED },
      });
    });

    it('5. 成功：changeOwnPassword 收到新密码的哈希，返回值透传', async () => {
      const updated = userResponse({ username: 'alice' });
      const captured: string[] = [];
      const { service, stubs } = buildService({
        changeOwnPassword: jest.fn((id: bigint, hash: string) => {
          captured.push(hash);
          return Promise.resolve(updated);
        }),
      });

      const result = await service.changePassword(1n, {
        oldPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
      });

      expect(stubs.changeOwnPassword).toHaveBeenCalledTimes(1);
      expect(captured).toHaveLength(1);
      // 断言落库的是「新密码」的哈希，而不是旧密码或明文
      expect(compareSync(NEW_PASSWORD, captured[0])).toBe(true);
      expect(compareSync(OLD_PASSWORD, captured[0])).toBe(false);
      expect(result).toBe(updated);
    });
  });

  describe('ssoAuthorize', () => {
    it('6. saveSsoState 被调用，且其第一个参数出现在返回的 authorizeUrl 里', async () => {
      const { service, stubs } = buildService();

      const result = await service.ssoAuthorize();

      expect(stubs.saveSsoState).toHaveBeenCalledTimes(1);
      const [state, ttlSeconds] = stubs.saveSsoState.mock.calls[0] as [
        string,
        number,
      ];
      expect(typeof state).toBe('string');
      expect(state.length).toBeGreaterThan(0);
      expect(result.authorizeUrl).toContain(state);
      expect(ttlSeconds).toBe(300);
    });
  });

  describe('ssoCallback', () => {
    it('7. 带 error → 20106，且 consumeSsoState 没被调用', async () => {
      const { service, stubs } = buildService();

      await expect(
        service.ssoCallback({
          state: 'some-state',
          ticket: 'ST-1',
          error: 'access_denied',
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.AUTH_SSO_STATE_INVALID },
      });
      expect(stubs.consumeSsoState).not.toHaveBeenCalled();
    });

    it('8. consumeSsoState 返回 false → 20106，且 exchangeTicket 没被调用', async () => {
      const { service, stubs } = buildService({
        consumeSsoState: jest.fn().mockResolvedValue(false),
      });

      await expect(
        service.ssoCallback({ state: 'stale-state', ticket: 'ST-1' }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.AUTH_SSO_STATE_INVALID },
      });
      expect(stubs.exchangeTicket).not.toHaveBeenCalled();
    });

    it('9. exchangeTicket 返回 null → 20106', async () => {
      const { service, stubs } = buildService({
        exchangeTicket: jest.fn().mockResolvedValue(null),
      });

      await expect(
        service.ssoCallback({ state: 'good-state', ticket: 'ST-bad' }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.AUTH_SSO_STATE_INVALID },
      });
      expect(stubs.signAccess).not.toHaveBeenCalled();
    });

    it('10. 本地无此工号 → 20107，且不签发令牌', async () => {
      const { service, stubs } = buildService({
        findByEmployeeNo: jest.fn().mockResolvedValue(null),
      });

      await expect(
        service.ssoCallback({ state: 'good-state', ticket: 'NO_SUCH_EMP' }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.AUTH_SSO_USER_UNKNOWN },
      });
      expect(stubs.recordLogin).not.toHaveBeenCalled();
      expect(stubs.signAccess).not.toHaveBeenCalled();
      expect(stubs.signRefresh).not.toHaveBeenCalled();
    });

    it('11. 本地有但 status !== 1 → 20102', async () => {
      const { service, stubs } = buildService({
        findByEmployeeNo: jest.fn().mockResolvedValue(sysUser({ status: 0 })),
      });

      await expect(
        service.ssoCallback({ state: 'good-state', ticket: 'E001' }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.AUTH_ACCOUNT_DISABLED },
      });
      expect(stubs.signAccess).not.toHaveBeenCalled();
    });

    it('12. 成功：recordLogin 被调用，且双令牌都签了', async () => {
      const { service, stubs } = buildService();

      const result = await service.ssoCallback({
        state: 'good-state',
        ticket: 'E001',
      });

      expect(stubs.consumeSsoState).toHaveBeenCalledWith('good-state');
      expect(stubs.recordLogin).toHaveBeenCalledWith(1n);
      expect(stubs.signAccess).toHaveBeenCalledTimes(1);
      expect(stubs.signRefresh).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresIn: 7200,
      });
    });
  });

  describe('login 分流与回退', () => {
    it('authSource=local → 不调 SSO，走本地 bcrypt', async () => {
      const { service, stubs } = buildService({
        findByUsername: jest
          .fn()
          .mockResolvedValue(sysUser({ authSource: 'local' })),
      });

      const tokens = await service.login({
        username: 'alice',
        password: OLD_PASSWORD,
      });

      expect(stubs.ssoLogin).not.toHaveBeenCalled();
      expect(tokens.accessToken).toBeDefined();
      expect(tokens.loginSource).toBe('local');
    });

    it('authSource=sso + SSO 成功 → 回写密码与信息，loginSource=sso', async () => {
      const { service, stubs } = buildService({
        findByUsername: jest.fn().mockResolvedValue(
          sysUser({
            authSource: 'sso',
            password: hashSync('old', BCRYPT_ROUNDS),
          }),
        ),
        ssoLogin: jest.fn().mockResolvedValue({
          user: {
            userName: 'E001',
            nickName: '新名字',
            userType: 'teacher',
            deptId: '10',
            deptName: '计算机学院',
            isDefaultPwd: false,
          },
        }),
      });

      const tokens = await service.login({
        username: 'alice',
        password: NEW_PASSWORD,
      });

      expect(stubs.ssoLogin).toHaveBeenCalledWith('alice', NEW_PASSWORD);
      const syncCall = stubs.syncSsoProfile.mock.calls[0] as [
        bigint,
        { realName: string; passwordHash: string | null },
      ];
      expect(syncCall[0]).toBe(1n);
      expect(syncCall[1].realName).toBe('新名字');
      expect(typeof syncCall[1].passwordHash).toBe('string');
      expect(tokens.loginSource).toBe('sso');
      expect(tokens.isDefaultPwd).toBe(false);
    });

    it('SSO 凭据错误 → 20101，不回退本地', async () => {
      const { service, stubs } = buildService({
        findByUsername: jest.fn().mockResolvedValue(
          sysUser({
            authSource: 'sso',
            password: hashSync(NEW_PASSWORD, BCRYPT_ROUNDS),
          }),
        ),
        ssoLogin: jest
          .fn()
          .mockRejectedValue(new SsoApiError('credentials', '账号或密码错误')),
      });

      await expect(
        service.login({ username: 'alice', password: NEW_PASSWORD }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.AUTH_CREDENTIALS_INVALID },
      });
      expect(stubs.syncSsoProfile).not.toHaveBeenCalled();
    });

    it('SSO 不可达 + 本地密码正确 → loginSource=local-fallback', async () => {
      const { service } = buildService({
        findByUsername: jest.fn().mockResolvedValue(
          sysUser({
            authSource: 'sso',
            password: hashSync(OLD_PASSWORD, BCRYPT_ROUNDS),
          }),
        ),
        ssoLogin: jest
          .fn()
          .mockRejectedValue(new SsoApiError('unavailable', 'timeout')),
      });

      const tokens = await service.login({
        username: 'alice',
        password: OLD_PASSWORD,
      });

      expect(tokens.loginSource).toBe('local-fallback');
      expect(tokens.ssoUnavailable).toBe(true);
    });

    it('SSO 不可达 + 本地密码错误 → 20101，并记一次失败', async () => {
      const { service, stubs } = buildService({
        findByUsername: jest.fn().mockResolvedValue(
          sysUser({
            authSource: 'sso',
            password: hashSync(OLD_PASSWORD, BCRYPT_ROUNDS),
          }),
        ),
        ssoLogin: jest
          .fn()
          .mockRejectedValue(new SsoApiError('unavailable', 'timeout')),
      });

      await expect(
        service.login({ username: 'alice', password: NEW_PASSWORD }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.AUTH_CREDENTIALS_INVALID },
      });
      expect(stubs.registerLoginFailure).toHaveBeenCalledWith('alice');
    });

    it('SSO 不可达 + 本地无账号 → 20108', async () => {
      const { service } = buildService({
        findByUsername: jest.fn().mockResolvedValue(null),
        ssoLogin: jest
          .fn()
          .mockRejectedValue(new SsoApiError('unavailable', 'timeout')),
      });

      await expect(
        service.login({ username: 'nobody', password: 'x' }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.AUTH_SSO_UNAVAILABLE },
      });
    });

    it('SSO 返回 5xx 且 fallbackOn5xx=false → 20108，不回退本地', async () => {
      const { service, stubs } = buildService({
        findByUsername: jest.fn().mockResolvedValue(
          sysUser({
            authSource: 'sso',
            password: hashSync(OLD_PASSWORD, BCRYPT_ROUNDS),
          }),
        ),
        ssoLogin: jest
          .fn()
          .mockRejectedValue(
            new SsoApiError('unavailable', 'bad gateway', 502),
          ),
      });

      await expect(
        service.login({ username: 'alice', password: OLD_PASSWORD }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.AUTH_SSO_UNAVAILABLE },
      });
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
          findByUsername: jest
            .fn()
            .mockResolvedValue(sysUser({ authSource: 'sso' })),
          ssoLogin: jest.fn().mockRejectedValue(new SsoApiError(kind, kind)),
        });

        await expect(
          service.login({ username: 'alice', password: 'x' }),
        ).rejects.toMatchObject({ response: { code } });
      }
    });
  });
});
