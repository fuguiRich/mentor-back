import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

/**
 * 常用收件角色（前端下拉的默认选项）。
 *
 * 后端不把它当白名单：自定义角色也可以发，服务层只校验角色 code 是否真实存在。
 */
export const MESSAGE_RECIPIENT_ROLE_CODES = [
  'student',
  'teacher',
  'mentor',
  'college_admin',
  'sc_admin',
] as const;

export type MessageRecipientRoleCode =
  (typeof MESSAGE_RECIPIENT_ROLE_CODES)[number];

/**
 * `POST /messages` 的请求体。
 *
 * 收件人两种模式**二选一**：
 * 1. `recipientUserIds`：精确指定用户；
 * 2. `recipientRoleCodes` / `deptId`：按角色和 / 或部门群发（AND）。
 *
 * 两种同时出现 → 400 / 10001。消息类型固定为 `4 系统通知`，不由调用方指定。
 */
export class SendMessageDto {
  @ApiPropertyOptional({
    description:
      '精确收件人（SysUser.id，BIGINT 对外字符串）；与角色 / 部门二选一',
    type: [String],
    example: ['5', '9'],
  })
  @IsOptional()
  @IsArray({ message: 'recipientUserIds 必须是数组' })
  @ArrayMaxSize(1000, { message: '单次最多 1000 个收件人' })
  @IsBigIntId({ each: true, message: 'recipientUserIds 必须是数字 ID 数组' })
  recipientUserIds?: string[];

  @ApiPropertyOptional({
    description:
      '按角色群发（SysRole.code，支持自定义角色）；与 recipientUserIds 二选一，可与 deptId 组合',
    type: [String],
    example: ['mentor'],
  })
  @IsOptional()
  @IsArray({ message: 'recipientRoleCodes 必须是数组' })
  @ArrayMaxSize(10, { message: '最多选择 10 个角色' })
  @IsString({ each: true, message: 'recipientRoleCodes 每项必须是字符串' })
  @MaxLength(50, { each: true, message: '角色 code 最多 50 个字符' })
  recipientRoleCodes?: string[];

  @ApiPropertyOptional({
    description:
      '按部门群发（SysDept.id）；与 recipientUserIds 二选一，可与角色组合',
    example: '2',
  })
  @IsOptional()
  @IsBigIntId({ message: 'deptId 必须是合法的数字 ID' })
  deptId?: string;

  @ApiProperty({
    description: '标题，1-100 字符',
    example: '关于本学期导师考核的通知',
  })
  @IsString({ message: '标题必须是字符串' })
  @Length(1, 100, { message: '标题长度需在 1 到 100 个字符之间' })
  title!: string;

  @ApiProperty({
    description: '正文，1-500 字符',
    example: '请各位导师于 11 月 20 日前完成考核材料提交。',
  })
  @IsString({ message: '正文必须是字符串' })
  @Length(1, 500, { message: '正文长度需在 1 到 500 个字符之间' })
  content!: string;
}
