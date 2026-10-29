import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { CreateRoleDto } from './create-role.dto';

/**
 * PUT 是全量替换语义，name 保持必填；其余字段省略表示「不改动」（规范 DTO-13）。
 * 派生会连 POST 语义的字段注解一起继承，下面把需要 PUT 真语义的属性
 * 连同 swagger 注解重声明一遍——只带 swagger、不带 class-validator
 * （校验元数据沿原型链叠加，重声明改不动校验行为）。
 */
export class UpdateRoleDto extends PartialType(
  OmitType(CreateRoleDto, ['name'] as const),
) {
  @ApiProperty({
    description: '角色名称（不唯一，可重复）',
    example: '教务管理员',
  })
  @IsString()
  @Length(2, 50, { message: '角色名称长度需在 2 到 50 个字符之间' })
  name!: string;

  @ApiPropertyOptional({
    description: '角色编码；不传表示保持原值',
    example: 'academic_admin',
  })
  code?: string;

  @ApiPropertyOptional({
    description: '状态：1 启用 / 0 停用；不传表示保持原值',
    example: 1,
    enum: [1, 0],
  })
  status?: number;

  @ApiPropertyOptional({
    description: '数据范围；不传表示保持原值',
    example: 'dept',
    enum: ['all', 'deptAndChildren', 'dept', 'self'],
  })
  dataScope?: string;
}
