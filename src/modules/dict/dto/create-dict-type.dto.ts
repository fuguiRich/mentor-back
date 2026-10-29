import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

/** 字典类型编码：小写字母开头，可含数字、下划线、连字符（前端拿它当下拉的 key） */
export const DICT_TYPE_CODE_PATTERN = /^[a-z][a-z0-9_-]*$/;

export class CreateDictTypeDto {
  @ApiProperty({
    description:
      '字典类型编码，全局唯一；小写字母开头，可含数字、下划线与连字符',
    example: 'gender',
  })
  @IsString()
  @MaxLength(50, { message: '字典类型编码长度不能超过 50 个字符' })
  @Matches(DICT_TYPE_CODE_PATTERN, {
    message: '字典类型编码只能是小写字母、数字、下划线与连字符，且以字母开头',
  })
  code!: string;

  @ApiProperty({ description: '字典类型名称', example: '性别' })
  @IsString()
  @Length(2, 50, { message: '字典类型名称长度需在 2 到 50 个字符之间' })
  name!: string;

  @ApiPropertyOptional({
    description: '状态：1 启用 / 0 停用；不传时为 1',
    example: 1,
    enum: [1, 0],
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn([1, 0], { message: '状态只能是 1（启用）或 0（停用）' })
  status?: number;

  @ApiPropertyOptional({ description: '备注', example: '用户性别选项' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  remark?: string;
}
