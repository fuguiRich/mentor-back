import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class QueryDictItemDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description:
      '按字典类型 ID 过滤；与 dictTypeCode 同时传时按 AND 过滤（通常只传一个）',
    example: '1',
  })
  @IsOptional()
  @IsBigIntId({ message: '字典类型 ID 必须是合法的数字 ID' })
  dictTypeId?: string;

  @ApiPropertyOptional({
    description:
      '按字典类型编码过滤——前端手上通常是编码不是 ID。传了不存在的编码返回空列表（同 role 筛选的裁决 R13）',
    example: 'gender',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: '字典类型编码长度不能超过 50 个字符' })
  dictTypeCode?: string;

  @ApiPropertyOptional({
    description: '字典项文案，模糊匹配',
    example: '男',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: '字典项文案长度不能超过 50 个字符' })
  label?: string;

  @ApiPropertyOptional({
    description: '状态筛选：1 启用 / 0 停用；不传表示全部',
    example: 1,
    enum: [1, 0],
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn([1, 0], { message: '状态只能是 1（启用）或 0（停用）' })
  status?: number;
}
