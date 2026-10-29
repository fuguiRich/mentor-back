import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../../../common/constants/auth.constants';

export class ResetUserPasswordDto {
  @ApiProperty({
    description:
      '新密码。**不校验旧密码**（这是管理员重置，不是本人改密）。' +
      '重置会作废该用户全部已签发令牌（R14）。超管账号只有超管能重置（R21）。',
    example: 'Passw0rd!',
  })
  @IsString()
  @Length(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, {
    message: `密码长度需在 ${PASSWORD_MIN_LENGTH} 到 ${PASSWORD_MAX_LENGTH} 个字符之间`,
  })
  password!: string;
}
