import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * `PUT /users/:id/super-admin` 的请求体。
 *
 * 只有超级管理员能调用；`false` 不能用于取消自己（会锁死唯一超管）。
 */
export class UpdateUserSuperAdminDto {
  @ApiProperty({
    description: 'true = 设为超级管理员；false = 取消超级管理员',
    example: true,
  })
  @IsBoolean({ message: 'isSuperAdmin 必须是布尔值' })
  isSuperAdmin!: boolean;
}
