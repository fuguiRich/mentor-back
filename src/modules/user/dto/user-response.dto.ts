import { ApiProperty } from '@nestjs/swagger';

export class UserResponseDto {
  @ApiProperty({ description: '用户 ID', example: '1' })
  id!: string;

  @ApiProperty({ description: '用户名（登录名）', example: 'zhangsan' })
  username!: string;

  @ApiProperty({ description: '真实姓名', example: '张三' })
  realName!: string;

  @ApiProperty({ description: '工号', example: 'T2026001' })
  employeeNo!: string;

  @ApiProperty({
    type: String,
    description: '手机号',
    example: '13800138000',
    nullable: true,
  })
  mobile!: string | null;

  @ApiProperty({ description: '归属部门 ID', example: '1' })
  deptId!: string;

  @ApiProperty({
    type: String,
    description: '归属部门名称（列表与详情展示用）',
    example: '信息中心',
    nullable: true,
  })
  deptName!: string | null;

  @ApiProperty({
    description: '状态：1 启用 / 0 停用',
    example: 1,
    enum: [1, 0],
  })
  status!: number;

  @ApiProperty({
    description: '超管标志。为 true 时跳过全部权限检查',
    example: false,
  })
  isSuperAdmin!: boolean;

  @ApiProperty({
    type: String,
    description: '最后登录时间（UTC，ISO 8601）',
    example: '2026-10-14T03:00:00.000Z',
    nullable: true,
  })
  lastLoginAt!: string | null;

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
