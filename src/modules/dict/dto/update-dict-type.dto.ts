import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { CreateDictTypeDto } from './create-dict-type.dto';

/**
 * PUT 是全量替换语义，name 保持必填；其余字段省略表示「不改动」（规范 DTO-13）。
 * 派生会把 POST 语义的注解一起继承，所以这里把 PUT 真语义的属性重声明一遍
 * （同 update-role.dto.ts 的说明）。
 */
export class UpdateDictTypeDto extends PartialType(
  OmitType(CreateDictTypeDto, ['name'] as const),
) {
  @ApiProperty({ description: '字典类型名称', example: '性别' })
  @IsString()
  @Length(2, 50, { message: '字典类型名称长度需在 2 到 50 个字符之间' })
  name!: string;

  @ApiPropertyOptional({
    description: '字典类型编码；不传表示保持原值',
    example: 'gender',
  })
  code?: string;

  @ApiPropertyOptional({
    description: '状态：1 启用 / 0 停用；不传表示保持原值',
    example: 1,
    enum: [1, 0],
  })
  status?: number;
}
