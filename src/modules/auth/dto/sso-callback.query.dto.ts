import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * 统一认证回调的查询参数。
 *
 * 参数名固定为 `ticket`，**不跟着学校协议叫 `code`**：本接口是我们的契约，
 * 学校换成 CAS 也好、OAuth2 也好，换的是 SsoProvider 的实现（把它当 code 还是
 * 当 service ticket），不是我们的 URL 形状。改契约的代价是前端跟着改，不值得。
 */
export class SsoCallbackQueryDto {
  @ApiProperty({
    description: '由 GET /auth/sso/authorize 生成、并原样带回的防伪随机串',
    example: '9f86d081884c7d659a2feaa0c55ad015',
  })
  @IsString()
  @MaxLength(256, { message: 'state 长度不能超过 256 个字符' })
  state!: string;

  @ApiPropertyOptional({
    description:
      '学校认证后带回的票据（OIDC 的 authorization code / CAS 的 service ticket）。' +
      '上游拒绝登录时（带回 error）**没有**这个字段——RFC 6749 的错误重定向就只有 state + error，' +
      '所以它不是必填；带 error 时服务端也不读它。',
    example: 'ST-1234-abcdef',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048, { message: 'ticket 长度不能超过 2048 个字符' })
  ticket?: string;

  @ApiPropertyOptional({
    description:
      '上游认证被拒时带回的错误码（如 access_denied）。有值时**不再**去换票据，' +
      '直接回统一认证失败——用户点了"取消"，不是网络问题。',
    example: 'access_denied',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  error?: string;
}
