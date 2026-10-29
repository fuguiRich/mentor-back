import { ApiProperty } from '@nestjs/swagger';

export class FieldErrorDto {
  @ApiProperty({
    description: '出错的字段名（嵌套字段用点号连接）',
    example: 'name',
  })
  field!: string;

  @ApiProperty({
    description: '该字段的错误说明',
    example: '长度不能少于 2 个字符',
  })
  message!: string;
}

export class ValidationErrorDataDto {
  @ApiProperty({ type: () => [FieldErrorDto], description: '逐字段的错误清单' })
  fields!: FieldErrorDto[];
}
