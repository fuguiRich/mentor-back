import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiNoContentResponse,
} from '@nestjs/swagger';
import { ErrorCode } from '../../common/constants/error-code';
import { errExample, errExamples } from '../../common/dto/err-example';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { NoEnvelope } from '../../common/decorators/no-envelope.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/context/request-context';
import { AuthService } from './auth.service';
import { AuthTokensResponseDto } from './dto/auth-tokens.response.dto';
import { LoginDto } from './dto/login.dto';
import { LogoutDto } from './dto/logout.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { AuthProfileResponseDto } from './dto/auth-profile.response.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { SsoAuthorizeResponseDto } from './dto/sso-authorize.response.dto';
import { SsoCallbackQueryDto } from './dto/sso-callback.query.dto';
import { UserResponseDto } from '../user/dto/user-response.dto';

@ApiTags('认证')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '登录（统一认证优先，网络不可达时回退本地密码）',
    description:
      '`SSO_LOGIN_ENABLED=true` 时：SSO 账号先调学校统一认证 api-login，成功后回写本地信息与密码；' +
      '**只有网络层不可达（超时 / DNS / 连接失败 / TLS）才回退本地 bcrypt**，' +
      'SSO 明确返回密码错误 / 锁定 / 应用禁用时一律不回退。' +
      '本地账号（authSource=local，超管与管理员）始终走本地密码。' +
      '响应里的 loginSource 告诉前端本次是 sso / local / local-fallback。' +
      '连续 5 次本地密码失败会锁定 15 分钟；SSO 的锁定由统一认证自己负责。',
  })
  @ApiOkResponse({
    type: AuthTokensResponseDto,
    description: '登录成功，返回双令牌',
  })
  @ApiUnauthorizedResponse({
    description: '用户名或密码错误 / 账号已停用 / 登录失败次数过多',
    schema: {
      oneOf: errExamples(
        [ErrorCode.AUTH_CREDENTIALS_INVALID, '用户名或密码错误'],
        [ErrorCode.AUTH_ACCOUNT_DISABLED, '账号已停用，请联系管理员'],
        [ErrorCode.AUTH_LOGIN_LOCKED, '登录失败次数过多，请稍后再试'],
      ).map((example) => ({ example })),
    },
  })
  async login(@Body() dto: LoginDto): Promise<AuthTokensResponseDto> {
    return this.authService.login(dto);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '用 refresh 令牌换新的 access 令牌',
    description:
      '凭登录时拿到的 refresh 令牌换一枚新的 access 令牌。' +
      '**refresh 不轮换**：响应里的 refreshToken 就是请求里那个，有效期仍从登录算起满 7 天，' +
      '刷新不会延长它。改密码、停用、踢人下线都会让 refresh 立刻失效（会话版本 +1），' +
      '此时本接口返回 401。',
  })
  @ApiOkResponse({
    type: AuthTokensResponseDto,
    description: '换取成功，返回新的 access 令牌与原 refresh 令牌',
  })
  @ApiUnauthorizedResponse({
    description: 'refresh 令牌无效、已过期、已登出，或所属会话已失效',
    schema: {
      example: errExample(
        ErrorCode.AUTH_REFRESH_INVALID,
        '登录状态已失效，请重新登录',
      ),
    },
  })
  async refresh(@Body() dto: RefreshTokenDto): Promise<AuthTokensResponseDto> {
    return this.authService.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @NoEnvelope()
  @ApiOperation({
    summary: '登出',
    description:
      '让**本次会话**的两枚令牌同时失效：access 进黑名单（条目只活到它本身过期），' +
      'refresh 从白名单摘掉（仅当它属于当前用户时）。不踢其他设备——那是改密码或停用账号的语义，' +
      '不是登出的。重复登出不影响结果（204）；已失效的 refresh 令牌不会改变登出结果。',
  })
  @ApiNoContentResponse({ description: '登出成功，响应体为空' })
  @ApiUnauthorizedResponse({
    description: '未登录',
    schema: {
      example: errExample(ErrorCode.UNAUTHORIZED, '登录状态已失效，请重新登录'),
    },
  })
  async logout(
    @CurrentUser() user: RequestUser,
    @Body() dto: LogoutDto,
  ): Promise<void> {
    await this.authService.logout({
      userId: user.userId,
      accessJti: user.accessJti,
      accessExpiresAt: user.accessExpiresAt,
      refreshToken: dto.refreshToken,
    });
  }

  @Get('profile')
  @RequirePermission() // 登录即可：它返回的就是"我自己"，不再要一个权限码
  @ApiOperation({
    summary: '获取当前登录者画像',
    description:
      '一次返回三样东西：当前用户（含角色 ID）、可行使的权限码集合、可渲染的菜单树。' +
      '前端登录后拿它渲染侧边栏与按钮显隐，不必自己拼装权限。' +
      '超管的 permissions 是系统里全部启用的权限码（守卫对超管跳过检查）。' +
      '响应不含密码。',
  })
  @ApiOkResponse({
    type: AuthProfileResponseDto,
    description: '返回当前用户的画像',
  })
  async getProfile(
    @CurrentUser() user: RequestUser,
  ): Promise<AuthProfileResponseDto> {
    return this.authService.getProfile(user.userId);
  }

  @Put('password')
  @RequirePermission() // 同上：改的是自己的密码
  @ApiOperation({
    summary: '修改当前用户的密码（需校验旧密码）',
    description:
      '本人改密：必须提供当前密码。**改完会作废该用户全部已签发令牌，包括调用者自己**——' +
      '改密码的动因常常就是怀疑密码泄露了，把自己也踢下线才对。' +
      '前端在成功后应引导重新登录。重置**别人**的密码走 PUT /users/:id/password。',
  })
  @ApiOkResponse({
    type: UserResponseDto,
    description: '修改成功，返回用户记录（不含密码）',
  })
  @ApiBadRequestResponse({
    description: '原密码错误',
    schema: {
      example: errExample(ErrorCode.AUTH_PASSWORD_MISMATCH, '原密码错误'),
    },
  })
  async changePassword(
    @CurrentUser() user: RequestUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<UserResponseDto> {
    return this.authService.changePassword(user.userId, dto);
  }

  @Get('sso/authorize')
  @Public()
  @ApiOperation({
    summary: '取学校统一认证跳转 URL',
    description:
      '生成带防伪 state 的学校认证页地址，state 先落 Redis 再返回。' +
      '**后端不做 302**——前端拿到 URL 自己跳过去（裁决 R11：重定向目标与 token 的' +
      '回传方式尚未确定，现在定就是猜）。',
  })
  @ApiOkResponse({
    type: SsoAuthorizeResponseDto,
    description: '返回跳转地址；前端自行导航',
  })
  async ssoAuthorize(): Promise<SsoAuthorizeResponseDto> {
    return this.authService.ssoAuthorize();
  }

  @Get('sso/callback')
  @Public()
  @ApiOperation({
    summary: '学校统一认证回调',
    description:
      '校验 state 与票据 → 换工号 → 映射本地用户 → 签发本地双令牌。' +
      '**返回 JSON（与 POST /auth/login 同形），不做 302**（裁决 R11）。' +
      '本地没有这个账号时**不自动建号**，回 20107——谁能进这个系统由管理员决定。' +
      'state 一次性：同一 state 第二次回调必定失败。',
  })
  @ApiOkResponse({
    type: AuthTokensResponseDto,
    description: '认证成功，返回本地双令牌（与 POST /auth/login 同形）',
  })
  @ApiBadRequestResponse({
    description: 'state 无效 / 已用过 / 票据换不出工号',
    schema: {
      example: errExample(
        ErrorCode.AUTH_SSO_STATE_INVALID,
        '统一认证未通过，请重新发起登录',
      ),
    },
  })
  @ApiForbiddenResponse({
    description: '统一认证通过但本系统无此账号',
    schema: {
      example: errExample(
        ErrorCode.AUTH_SSO_USER_UNKNOWN,
        '统一认证已通过，但本系统没有对应账号，请联系管理员',
      ),
    },
  })
  async ssoCallback(
    @Query() query: SsoCallbackQueryDto,
  ): Promise<AuthTokensResponseDto> {
    return this.authService.ssoCallback(query);
  }
}
