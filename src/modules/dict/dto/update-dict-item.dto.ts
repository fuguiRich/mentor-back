import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { CreateDictItemDto } from './create-dict-item.dto';

/**
 * PUT 全量替换，label 保持必填；其余省略表示「不改动」。
 * `dictTypeId` 不在可改之列——字典项搬家等于删旧建新，改外键会让
 * 「同类型内 value 唯一」这条约束的语义跟着漂。
 */
export class UpdateDictItemDto extends PartialType(
  OmitType(CreateDictItemDto, ['label', 'dictTypeId'] as const),
) {
  @ApiProperty({ description: '给人看的文案', example: '男' })
  @IsString()
  @Length(1, 50, { message: '字典项文案长度需在 1 到 50 个字符之间' })
  label!: string;

  @ApiPropertyOptional({
    description: '存进业务表的值；不传表示保持原值',
    example: 'M',
  })
  value?: string;

  @ApiPropertyOptional({
    description: '同类型内排序值，小的在前；不传表示保持原值',
    example: 0,
  })
  sortOrder?: number;

  @ApiPropertyOptional({
    description: '状态：1 启用 / 0 停用；不传表示保持原值',
    example: 1,
    enum: [1, 0],
  })
  status?: number;
}
