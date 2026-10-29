import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

/**
 * 用户列表筛选（spec 第 8 节：按用户名/姓名/工号/部门/状态/**角色**筛选）。
 * `roleId` 是角色详情页展示成员的唯一入口（spec 第 4 节：`GET /roles/:id/users`
 * 并入了这里）。传了不存在的角色 ID 返回空列表，不 404（裁决 R13）。
 */
export class QueryUserDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '用户名，模糊匹配', example: 'zhang' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  username?: string;

  @ApiPropertyOptional({ description: '真实姓名，模糊匹配', example: '张' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  realName?: string;

  @ApiPropertyOptional({ description: '工号，模糊匹配', example: 'T00' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  employeeNo?: string;

  @ApiPropertyOptional({
    description:
      '部门 ID，**精确**匹配本部门（不含下级部门）。超出调用者数据范围时返回 403，不是空列表',
    example: '1',
  })
  @IsOptional()
  @IsBigIntId({ message: '部门 ID 必须是合法的数字 ID' })
  deptId?: string;

  @ApiPropertyOptional({
    description: '状态筛选：1 启用 / 0 停用；不传表示全部',
    example: 1,
    enum: [1, 0],
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn([1, 0], { message: '状态只能是 1（启用）或 0（停用）' })
  status?: number;

  @ApiPropertyOptional({
    description: '角色 ID；筛出持有该角色的用户（角色的成员列表）',
    example: '1',
  })
  @IsOptional()
  @IsBigIntId({ message: '角色 ID 必须是合法的数字 ID' })
  roleId?: string;
}
