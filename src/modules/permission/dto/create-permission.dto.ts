import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import {
  PERMISSION_CODE_PATTERN,
  PERMISSION_TYPES,
  type PermissionType,
} from '../permission.constants';

export class CreatePermissionDto {
  @ApiPropertyOptional({
    // `string | null` 的 design:type 是 Object，必须显式写 type
    type: String,
    description: '上级权限点 ID；不传表示创建根节点',
    example: '1',
    nullable: true,
  })
  @IsOptional()
  @IsBigIntId({ message: '上级权限点 ID 必须是合法的数字 ID' })
  parentId?: string | null;

  @ApiProperty({
    description:
      '权限点类型：DIR 目录（仅前端菜单分组，不对应接口）/ MENU 菜单页 / BUTTON 按钮（对应写操作接口）',
    example: 'MENU',
    enum: [...PERMISSION_TYPES],
  })
  @IsIn(PERMISSION_TYPES, { message: '类型只能是 DIR、MENU 或 BUTTON' })
  type!: PermissionType;

  @ApiPropertyOptional({
    type: String,
    description:
      '权限码，格式 <资源>:<动作>，如 user:list。' +
      'DIR 类型必须不设，MENU / BUTTON 必填——这条规则不在 DTO 层判，' +
      '由服务端按最终形态回 23103 / 23104（裁决 R8）',
    example: 'user:list',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: '权限码长度不能超过 100 个字符' })
  @Matches(PERMISSION_CODE_PATTERN, {
    message: '权限码格式为 <资源>:<动作>，小写字母、数字与中划线，如 user:list',
  })
  code?: string | null;

  @ApiProperty({ description: '权限点名称', example: '用户管理' })
  @IsString()
  @Length(2, 50, { message: '权限点名称长度需在 2 到 50 个字符之间' })
  name!: string;

  @ApiPropertyOptional({
    type: String,
    description: '路由地址（MENU 用）',
    example: '/system/users',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: '路由地址长度不能超过 200 个字符' })
  path?: string | null;

  @ApiPropertyOptional({
    type: String,
    description: '前端组件路径（MENU 用）',
    example: 'system/user/index',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: '组件路径长度不能超过 200 个字符' })
  component?: string | null;

  @ApiPropertyOptional({
    type: String,
    description: '菜单图标名',
    example: 'user',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: '图标名长度不能超过 50 个字符' })
  icon?: string | null;

  @ApiPropertyOptional({
    // 不写 default：PUT 下「不传」是保持原值，不存在这样一个值
    description: '同级排序值，小的在前；不传时为 0',
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
}
