import { ApiProperty } from '@nestjs/swagger';

export class DictTypeResponseDto {
  @ApiProperty({ description: '字典类型 ID', example: '1' })
  id!: string;

  @ApiProperty({ description: '字典类型编码，全局唯一', example: 'gender' })
  code!: string;

  @ApiProperty({ description: '字典类型名称', example: '性别' })
  name!: string;

  @ApiProperty({
    description: '状态：1 启用 / 0 停用',
    example: 1,
    enum: [1, 0],
  })
  status!: number;

  @ApiProperty({
    type: String,
    description: '备注',
    example: '用户性别选项',
    nullable: true,
  })
  remark!: string | null;

  @ApiProperty({
    description: '创建时间（UTC，ISO 8601）',
    example: '2026-10-20T03:00:00.000Z',
  })
  createdAt!: string;

  @ApiProperty({
    description: '最后修改时间（UTC，ISO 8601）',
    example: '2026-10-20T03:00:00.000Z',
  })
  updatedAt!: string;

  @ApiProperty({ description: '创建人用户标识；0 表示系统', example: '0' })
  createdBy!: string;

  @ApiProperty({ description: '最后修改人用户标识；0 表示系统', example: '0' })
  updatedBy!: string;
}
