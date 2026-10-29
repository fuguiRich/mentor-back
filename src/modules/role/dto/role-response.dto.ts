import { ApiProperty } from '@nestjs/swagger';

export class RoleResponseDto {
  @ApiProperty({ description: '角色 ID', example: '1' })
  id!: string;

  @ApiProperty({ description: '角色名称（不唯一）', example: '教务管理员' })
  name!: string;

  @ApiProperty({ description: '角色编码，全局唯一', example: 'academic_admin' })
  code!: string;

  @ApiProperty({
    description:
      '数据范围：all 全校 / deptAndChildren 本部门及以下 / dept 本部门 / self 仅本人',
    example: 'dept',
    enum: ['all', 'deptAndChildren', 'dept', 'self'],
  })
  dataScope!: string;

  @ApiProperty({
    description: '状态：1 启用 / 0 停用',
    example: 1,
    enum: [1, 0],
  })
  status!: number;

  @ApiProperty({
    type: String,
    description: '备注',
    example: '负责成绩录入与审核',
    nullable: true,
  })
  remark!: string | null;

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
