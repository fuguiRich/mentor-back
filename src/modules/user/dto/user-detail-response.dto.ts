import { ApiProperty } from '@nestjs/swagger';
import { UserResponseDto } from './user-response.dto';

/** 详情与分配接口用；列表不带 roleIds（避免 N+1） */
export class UserDetailResponseDto extends UserResponseDto {
  @ApiProperty({
    type: [String],
    description: '已分配的角色 ID 集合',
    example: ['1', '2'],
  })
  roleIds!: string[];
}
