import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../../../common/constants/auth.constants';

export class ChangePasswordDto {
  @ApiProperty({
    description: '当前密码。**必须校验**——这是本人改密，不是管理员重置',
    example: 'Passw0rd!',
  })
  @IsString()
  @Length(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, {
    message: `密码长度需在 ${PASSWORD_MIN_LENGTH} 到 ${PASSWORD_MAX_LENGTH} 个字符之间`,
  })
  oldPassword!: string;

  @ApiProperty({
    description: '新密码',
    example: 'NewPassw0rd!',
  })
  @IsString()
  @Length(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, {
    message: `密码长度需在 ${PASSWORD_MIN_LENGTH} 到 ${PASSWORD_MAX_LENGTH} 个字符之间`,
  })
  newPassword!: string;
}
