import { ApiProperty } from '@nestjs/swagger';

export class DictItemResponseDto {
  @ApiProperty({ description: '字典项 ID', example: '1' })
  id!: string;

  @ApiProperty({ description: '所属字典类型 ID', example: '1' })
  dictTypeId!: string;

  @ApiProperty({ description: '给人看的文案', example: '男' })
  label!: string;

  @ApiProperty({
    description: '存进业务表的值',
    example: 'M',
  })
  value!: string;

  @ApiProperty({ description: '同类型内排序值，小的在前', example: 0 })
  sortOrder!: number;

  @ApiProperty({
    description: '状态：1 启用 / 0 停用',
    example: 1,
    enum: [1, 0],
  })
  status!: number;

  @ApiProperty({
    type: String,
    description: '备注',
    example: '默认项',
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
