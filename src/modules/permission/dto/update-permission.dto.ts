import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { PERMISSION_TYPES, type PermissionType } from '../permission.constants';
import { CreatePermissionDto } from './create-permission.dto';

/**
 * PUT 是全量替换语义，name 保持必填；其余字段省略表示「不改动」（规范 DTO-13）。
 * 派生会连 POST 语义的字段注解一起继承，下面把需要 PUT 真语义的属性
 * 连同 swagger 注解重声明一遍——只带 swagger、不带 class-validator
 * （校验元数据沿原型链叠加，重声明改不动校验行为）。
 */
export class UpdatePermissionDto extends PartialType(
  OmitType(CreatePermissionDto, ['name'] as const),
) {
  @ApiProperty({ description: '权限点名称', example: '用户管理' })
  @IsString()
  @Length(2, 50, { message: '权限点名称长度需在 2 到 50 个字符之间' })
  name!: string;

  @ApiPropertyOptional({
    type: String,
    description:
      '上级权限点 ID；不传表示保持原值；显式传 null 表示提升为根节点',
    example: '1',
    nullable: true,
  })
  parentId?: string | null;

  @ApiPropertyOptional({
    description:
      '权限点类型；不传表示保持原值。只改 type 时也一样受「DIR 无码、MENU/BUTTON 有码」约束，' +
      '违反回 23103 / 23104',
    example: 'MENU',
    enum: [...PERMISSION_TYPES],
  })
  type?: PermissionType;

  @ApiPropertyOptional({
    type: String,
    description:
      '权限码；不传表示保持原值；显式传 null 表示清空。' +
      'DIR 类型必须为空，所以「把 MENU 改成 DIR」要连 code: null 一起传',
    example: 'user:list',
    nullable: true,
  })
  code?: string | null;

  @ApiPropertyOptional({
    description: '同级排序值，小的在前；不传表示保持原值',
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
