import { ApiProperty } from '@nestjs/swagger';
import { PERMISSION_TYPES, type PermissionType } from '../permission.constants';

export class PermissionResponseDto {
  @ApiProperty({ description: '权限点 ID', example: '1' })
  id!: string;

  @ApiProperty({
    type: String,
    description: '上级权限点 ID，根节点为 null',
    example: null,
    nullable: true,
  })
  parentId!: string | null;

  @ApiProperty({
    description: '类型：DIR 目录 / MENU 菜单页 / BUTTON 按钮',
    example: 'MENU',
    enum: [...PERMISSION_TYPES],
  })
  type!: PermissionType;

  @ApiProperty({
    type: String,
    description: '权限码，格式 <资源>:<动作>；DIR 类型为 null',
    example: 'user:list',
    nullable: true,
  })
  code!: string | null;

  @ApiProperty({ description: '权限点名称', example: '用户管理' })
  name!: string;

  @ApiProperty({
    type: String,
    description: '路由地址',
    example: '/system/users',
    nullable: true,
  })
  path!: string | null;

  @ApiProperty({
    type: String,
    description: '前端组件路径',
    example: 'system/user/index',
    nullable: true,
  })
  component!: string | null;

  @ApiProperty({
    type: String,
    description: '菜单图标名',
    example: 'user',
    nullable: true,
  })
  icon!: string | null;

  @ApiProperty({ description: '同级排序值，小的在前', example: 0 })
  sortOrder!: number;

  @ApiProperty({
    description: '状态：1 启用 / 0 停用',
    example: 1,
    enum: [1, 0],
  })
  status!: number;

  @ApiProperty({
    description: '创建时间（UTC，ISO 8601）',
    example: '2026-10-14T03:00:00.000Z',
  })
  createdAt!: string;

  @ApiProperty({
    description: '最后修改时间（UTC，ISO 8601）',
    example: '2026-10-14T03:00:00.000Z',
  })
  updatedAt!: string;

  @ApiProperty({ description: '创建人用户标识；0 表示系统', example: '0' })
  createdBy!: string;

  @ApiProperty({ description: '最后修改人用户标识；0 表示系统', example: '0' })
  updatedBy!: string;
}
