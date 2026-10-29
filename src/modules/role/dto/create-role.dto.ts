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
import { DATA_SCOPE_VALUES } from '../../../common/constants/data-scope';
import { ROLE_CODE_PATTERN } from '../role.constants';

export class CreateRoleDto {
  @ApiProperty({
    description: '角色名称（不唯一，可重复）',
    example: '教务管理员',
  })
  @IsString()
  @Length(2, 50, { message: '角色名称长度需在 2 到 50 个字符之间' })
  name!: string;

  @ApiProperty({
    description:
      '角色编码，全局唯一；小写字母开头，可含数字与下划线，如 super_admin',
    example: 'academic_admin',
  })
  @IsString()
  @MaxLength(50, { message: '角色编码长度不能超过 50 个字符' })
  @Matches(ROLE_CODE_PATTERN, {
    message: '角色编码只能是小写字母、数字与下划线，且以字母开头',
  })
  code!: string;

  @ApiPropertyOptional({
    description:
      '数据范围：all 全校 / deptAndChildren 本部门及以下 / dept 本部门 / self 仅本人；' +
      '不传时为 self（默认收得最紧）',
    example: 'dept',
    enum: ['all', 'deptAndChildren', 'dept', 'self'],
  })
  @IsOptional()
  @IsIn(DATA_SCOPE_VALUES, {
    message: '数据范围只能是 all / deptAndChildren / dept / self',
  })
  dataScope?: string;

  @ApiPropertyOptional({
    description: '状态：1 启用 / 0 停用；不传时为 1',
    example: 1,
    enum: [1, 0],
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn([1, 0], { message: '状态只能是 1（启用）或 0（停用）' })
  status?: number;

  @ApiPropertyOptional({ description: '备注', example: '负责成绩录入与审核' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  remark?: string;
}
