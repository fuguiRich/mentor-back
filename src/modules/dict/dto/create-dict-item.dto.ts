import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  IsInt,
} from 'class-validator';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

export class CreateDictItemDto {
  @ApiProperty({ description: '所属字典类型 ID', example: '1' })
  @IsBigIntId({ message: '字典类型 ID 必须是合法的数字 ID' })
  dictTypeId!: string;

  @ApiProperty({ description: '给人看的文案', example: '男' })
  @IsString()
  @Length(1, 50, { message: '字典项文案长度需在 1 到 50 个字符之间' })
  label!: string;

  @ApiProperty({
    description: '存进业务表的值；同类型内唯一',
    example: 'M',
  })
  @IsString()
  @MaxLength(50, { message: '字典项值长度不能超过 50 个字符' })
  value!: string;

  @ApiPropertyOptional({
    description: '同类型内排序值，小的在前；不传时为 0',
    example: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({
    description: '状态：1 启用 / 0 停用；不传时为 1',
    example: 1,
    enum: [1, 0],
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn([1, 0], { message: '状态只能是 1（启用）或 0（停用）' })
  status?: number;

  @ApiPropertyOptional({ description: '备注', example: '默认项' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  remark?: string;
}
