import { ApiProperty } from '@nestjs/swagger';
import { IsJWT } from 'class-validator';

/**
 * 登出要带上 refresh 令牌——只拉黑 access 是不够的：refresh 还能在白名单里活 7 天，
 * 「登出」的人拿着它随时能换一枚新 access 回来。所以 logout 必须同时摘掉 refresh。
 */
export class LogoutDto {
  @ApiProperty({
    description:
      '登录时签发的 refresh 令牌。服务端据此把它从白名单里摘掉；' +
      '传了不属于当前用户的令牌会被拒绝，避免"登出别人"。',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxx',
  })
  @IsJWT({ message: 'refresh 令牌格式不正确' })
  refreshToken!: string;
}
