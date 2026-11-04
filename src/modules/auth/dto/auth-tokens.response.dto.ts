import { ApiProperty } from '@nestjs/swagger';

export class AuthTokensResponseDto {
  @ApiProperty({
    description:
      '访问令牌（JWT）。默认 2 小时有效，可用 JWT_ACCESS_TTL_SECONDS 调整',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxx',
  })
  accessToken!: string;

  @ApiProperty({
    description:
      '刷新令牌（JWT）。默认 7 天有效，可用 JWT_REFRESH_TTL_SECONDS 调整。' +
      '**不轮换**：刷新接口返回的是原令牌，有效期从登录那一刻起算满 7 天，不因刷新而延长',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.yyy',
  })
  refreshToken!: string;

  @ApiProperty({
    description: '访问令牌剩余有效秒数。前端用它提前刷新，不必自己解 JWT',
    example: 7200,
  })
  expiresIn!: number;

  @ApiProperty({
    description:
      '本次登录来源：sso = 统一认证；local = 本地账号；local-fallback = 统一认证网络不可达时回退本地密码。仅 POST /auth/login 返回',
    enum: ['sso', 'local', 'local-fallback'],
    required: false,
  })
  loginSource?: 'sso' | 'local' | 'local-fallback';

  @ApiProperty({
    description: '是否因统一认证不可用而回退本地密码。仅 POST /auth/login 返回',
    example: false,
    required: false,
  })
  ssoUnavailable?: boolean;

  @ApiProperty({
    type: Boolean,
    description:
      '统一认证返回的「是否仍在使用初始默认密码」。true 时前端应提示去统一认证平台改密，但不要拦截登录。仅 POST /auth/login 返回',
    example: false,
    nullable: true,
    required: false,
  })
  isDefaultPwd?: boolean | null;
}
