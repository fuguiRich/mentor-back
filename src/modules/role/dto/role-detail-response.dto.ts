import { ApiProperty } from '@nestjs/swagger';
import { RoleResponseDto } from './role-response.dto';

/** 详情与分配接口用：列表不带 permissionIds（避免 N+1） */
export class RoleDetailResponseDto extends RoleResponseDto {
  @ApiProperty({
    type: [String],
    description: '已分配的权限点 ID 集合',
    example: ['1', '2', '3'],
  })
  permissionIds!: string[];
}
