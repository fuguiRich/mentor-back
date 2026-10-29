import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { PageResponseDto } from '../../../common/dto/page-response.dto';
import { CONFIG_VALUE_TYPE_VALUES } from '../config.constants';
import { ConfigResponseDto } from './config-response.dto';

export class ConfigParamDto {
  @ApiProperty({ description: '配置 ID', example: '1' })
  @IsBigIntId({ message: '配置 ID 必须是合法的数字 ID' })
  id!: string;
}

export class CreateConfigDto {
  @ApiProperty({
    description:
      '配置编码，全局唯一；点号分层（如 appoint.ttlHours），业务代码按它取值',
    example: 'appoint.ttlHours',
  })
  @IsString()
  @MaxLength(100, { message: '配置编码长度不能超过 100 个字符' })
  code!: string;

  @ApiProperty({ description: '配置名称', example: '预约有效期（小时）' })
  @IsString()
  @Length(2, 50, { message: '配置名称长度需在 2 到 50 个字符之间' })
  name!: string;

  @ApiProperty({
    description:
      '配置值的字符串形态。boolean 只接受字面量 true / false；' +
      'number 接受可解析为有限数值的十进制串；json 必须是合法 JSON',
    example: '24',
  })
  @IsString()
  @MaxLength(500, { message: '配置值长度不能超过 500 个字符' })
  value!: string;

  @ApiProperty({
    description: '值类型；决定 value 怎么解析',
    example: 'number',
    enum: CONFIG_VALUE_TYPE_VALUES,
  })
  @IsIn(CONFIG_VALUE_TYPE_VALUES, {
    message: '配置值类型只能是 string / number / boolean / json',
  })
  valueType!: string;

  @ApiPropertyOptional({
    description: '状态：1 启用 / 0 停用；不传时为 1',
    example: 1,
    enum: [1, 0],
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn([1, 0], { message: '状态只能是 1（启用）或 0（停用）' })
  status?: number;

  @ApiPropertyOptional({
    description: '备注',
    example: '超过该时长未确认的预约自动作废',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  remark?: string;
}

/**
 * PUT 全量替换，name 与 value 必填；省略的字段表示保持原值。
 * `code` 可改但要走唯一性校验；`valueType` 可改但要与 value 重新对齐。
 */
export class UpdateConfigDto {
  @ApiProperty({ description: '配置名称', example: '预约有效期（小时）' })
  @IsString()
  @Length(2, 50, { message: '配置名称长度需在 2 到 50 个字符之间' })
  name!: string;

  @ApiProperty({
    description: '配置值的字符串形态',
    example: '24',
  })
  @IsString()
  @MaxLength(500, { message: '配置值长度不能超过 500 个字符' })
  value!: string;

  @ApiPropertyOptional({
    description: '配置编码；不传表示保持原值',
    example: 'appoint.ttlHours',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: '配置编码长度不能超过 100 个字符' })
  code?: string;

  @ApiPropertyOptional({
    description: '值类型；不传表示保持原值。改了类型必须同时给出相符的 value',
    example: 'number',
    enum: CONFIG_VALUE_TYPE_VALUES,
  })
  @IsOptional()
  @IsIn(CONFIG_VALUE_TYPE_VALUES, {
    message: '配置值类型只能是 string / number / boolean / json',
  })
  valueType?: string;

  @ApiPropertyOptional({
    description: '状态：1 启用 / 0 停用；不传表示保持原值',
    example: 1,
    enum: [1, 0],
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn([1, 0], { message: '状态只能是 1（启用）或 0（停用）' })
  status?: number;

  @ApiPropertyOptional({ description: '备注；不传表示保持原值' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  remark?: string;
}

export class QueryConfigDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '配置编码，模糊匹配',
    example: 'appoint',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: '配置编码长度不能超过 100 个字符' })
  code?: string;

  @ApiPropertyOptional({ description: '配置名称，模糊匹配', example: '预约' })
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: '配置名称长度不能超过 50 个字符' })
  name?: string;

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

export class ConfigPageResponseDto extends PageResponseDto<ConfigResponseDto> {
  // 重写 list 的注解：Swagger 推断不出泛型元素类型（spec 第 6 节 ⑤）。
  // `declare` 是编译要求：target ES2023 下 useDefineForClassFields 为 true
  // （同 role-page-response.dto.ts）。
  @ApiProperty({
    type: () => [ConfigResponseDto],
    description: '当前页的配置列表',
  })
  declare list: ConfigResponseDto[];
}
