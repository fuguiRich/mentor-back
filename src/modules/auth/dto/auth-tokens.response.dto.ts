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
}
