import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, MaxLength } from 'class-validator';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../../../common/constants/auth.constants';

export class LoginDto {
  @ApiProperty({ description: '用户名', example: 'admin', maxLength: 50 })
  @IsString()
  @MaxLength(50, { message: '用户名长度不能超过 50 个字符' })
  username!: string;

  @ApiProperty({
    description:
      '明文口令。长度上限 72 是 bcrypt 的字节上限——再长会被静默截断，' +
      '第 73 个字符起不参与比对，两口不同的长口令可能互认，所以在这里就挡掉',
    example: 'Passw0rd!',
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
  })
  @IsString()
  @Length(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, {
    message: `密码长度需在 ${PASSWORD_MIN_LENGTH} 到 ${PASSWORD_MAX_LENGTH} 个字符之间`,
  })
  password!: string;
}
