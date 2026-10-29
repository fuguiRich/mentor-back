import { ApiProperty } from '@nestjs/swagger';

export class SsoAuthorizeResponseDto {
  @ApiProperty({
    description:
      '学校统一认证页的跳转地址。**前端自己跳过去**（window.location 或 <a>），' +
      '后端不做 302——重定向目标与 token 的回传方式尚未确定（裁决 R11）。',
    example: 'https://auth.example.edu/login?client_id=...&state=9f86d081',
  })
  authorizeUrl!: string;
}
