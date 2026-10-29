import { ApiProperty } from '@nestjs/swagger';
import { IsJWT } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({
    description: '登录时签发的 refresh 令牌',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxx',
  })
  @IsJWT({ message: 'refresh 令牌格式不正确' })
  refreshToken!: string;
}
