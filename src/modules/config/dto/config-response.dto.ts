import { ApiProperty } from '@nestjs/swagger';

export class ConfigResponseDto {
  @ApiProperty({ description: '配置 ID', example: '1' })
  id!: string;

  @ApiProperty({
    description: '配置编码，全局唯一',
    example: 'appoint.ttlHours',
  })
  code!: string;

  @ApiProperty({ description: '配置名称', example: '预约有效期（小时）' })
  name!: string;

  @ApiProperty({
    description: '配置值的字符串形态；按 valueType 解析',
    example: '24',
  })
  value!: string;

  @ApiProperty({
    description: '值类型：string / number / boolean / json',
    example: 'number',
    enum: ['string', 'number', 'boolean', 'json'],
  })
  valueType!: string;

  @ApiProperty({
    description: '状态：1 启用 / 0 停用',
    example: 1,
    enum: [1, 0],
  })
  status!: number;

  @ApiProperty({
    type: String,
    description: '备注',
    example: '超过该时长未确认的预约自动作废',
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
