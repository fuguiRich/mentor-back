import { ApiProperty } from '@nestjs/swagger';

export class DeptResponseDto {
  @ApiProperty({ description: '部门 ID', example: '1' })
  id!: string;

  @ApiProperty({
    // 必须显式写 type：`string | null` 的运行时类型元数据（design:type）是 Object，
    // `nullable: true` 只声明「可以为 null」，不提供基础类型，
    // 少了 type 这一行 Nest 会把 schema 生成为 `type: object`，文档于是在说假话。
    type: String,
    description: '上级部门 ID，根部门为 null',
    example: null,
    nullable: true,
  })
  parentId!: string | null;

  @ApiProperty({ description: '部门名称', example: '信息中心' })
  name!: string;

  @ApiProperty({ description: '同级排序值，小的在前', example: 0 })
  sortOrder!: number;

  @ApiProperty({
    description: '状态：1 启用 / 0 停用',
    example: 1,
    enum: [1, 0],
  })
  status!: number;

  @ApiProperty({
    // 同 parentId：`string | null` 推断不出基础类型，必须显式写 type。
    type: String,
    description: '备注',
    example: '负责校内信息化建设',
    nullable: true,
  })
  remark!: string | null;

  @ApiProperty({
    description: '创建时间（UTC，ISO 8601）',
    example: '2026-10-12T03:00:00.000Z',
  })
  createdAt!: string;

  @ApiProperty({
    description: '最后修改时间（UTC，ISO 8601）',
    example: '2026-10-12T03:00:00.000Z',
  })
  updatedAt!: string;

  @ApiProperty({ description: '创建人用户标识；0 表示系统', example: '0' })
  createdBy!: string;

  @ApiProperty({ description: '最后修改人用户标识；0 表示系统', example: '0' })
  updatedBy!: string;
}
