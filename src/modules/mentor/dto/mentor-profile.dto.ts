import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * 导师专业档案的读 / 写 DTO（Task 11 + 12）。
 *
 * `MentorProfile` 是「我本人的专业档案」——一人一行、挂在 `SyncPerson` 上，
 * 所以**没有按 id 的入口**，响应里的 `id` 只是行标识（P2 检索按它取），
 * 不是「给别人建档」的路由入口。
 */

/** `MentorProfile.status` 的 6 个值。**由审核流驱动，接口不得直接改** */
export const MENTOR_PROFILE_STATUS = {
  DRAFT: 0,
  PENDING: 1,
  APPROVED: 2,
  REJECTED: 3,
  FROZEN: 4,
  REMOVED: 5,
} as const;

export type MentorProfileStatus =
  (typeof MENTOR_PROFILE_STATUS)[keyof typeof MENTOR_PROFILE_STATUS];

/** R55 status 门：只有这两个状态的行能被 PUT /mentor/profile 改到 */
export const MENTOR_PROFILE_WRITABLE_STATUSES: readonly number[] = [
  MENTOR_PROFILE_STATUS.DRAFT,
  MENTOR_PROFILE_STATUS.REJECTED,
];

export class MentorProfileResponseDto {
  @ApiProperty({ description: '档案行 ID（BIGINT 对外字符串）', example: '1' })
  id!: string;

  @ApiProperty({
    description:
      '归属人员（SyncPerson.id，BIGINT 对外字符串）。与 SysUser 之间没有外键，' +
      '自然键是 username ↔ login（schema 注释钉的）',
    example: '1',
  })
  personId!: string;

  @ApiProperty({
    description:
      '导师类型：internal 校内 / external 校外。**不落列**——由 SyncPerson.personType ' +
      '推导（internalMentor/teacher→internal，externalMentor→external），冗余一份就会跟同步源漂移',
    enum: ['internal', 'external'],
    example: 'internal',
  })
  mentorType!: 'internal' | 'external';

  @ApiProperty({
    description:
      '指导方向，自由文本数组（Ruling #13：不做字典 / 白名单）。' +
      '每项 ≤ 30 字符、数组 ≤ 5 项，允许 []',
    type: [String],
    example: ['创新创业', '人工智能'],
  })
  researchFields!: string[];

  @ApiProperty({
    type: String,
    description: '个人简介，≤ 2000 字符（R48）',
    example: '长期从事……',
    nullable: true,
  })
  summary!: string | null;

  @ApiProperty({
    type: String,
    description: '研究成果，≤ 2000 字符（R48）',
    example: '主持省部级课题 2 项……',
    nullable: true,
  })
  achievements!: string | null;

  @ApiProperty({
    type: String,
    description: '指导经验，≤ 2000 字符（R48）',
    example: '累计指导学生 30 人……',
    nullable: true,
  })
  guidanceExperience!: string | null;

  @ApiProperty({
    type: String,
    description:
      '合作单位，≤ 100 字符。**仅校外（mentorType=external）非空**；' +
      '校内导师落库时置 NULL（R49，不是 400）',
    example: '某某研究院',
    nullable: true,
  })
  affiliateOrg!: string | null;

  @ApiProperty({
    type: String,
    description:
      '社会任职，≤ 100 字符。**仅校外（mentorType=external）非空**；' +
      '校内导师落库时置 NULL（R49，不是 400）',
    example: '某某学会理事',
    nullable: true,
  })
  socialRoles!: string | null;

  @ApiProperty({
    type: String,
    description:
      '职称 / 资质，自由文本，≤ 100 字符（R28）。**内校 / 外校都填**——' +
      '与 affiliateOrg / socialRoles 不同，内校不置 NULL',
    example: '教授',
    nullable: true,
  })
  professionalTitle!: string | null;

  @ApiProperty({
    type: String,
    description:
      '导师本人维护的联系电话；NULL 表示回退到同步源的 SyncPerson.mobile',
    example: '13800000000',
    nullable: true,
  })
  contactMobile!: string | null;

  @ApiProperty({
    description:
      '档案状态：0 DRAFT | 1 PENDING | 2 APPROVED | 3 REJECTED | 4 FROZEN | 5 REMOVED。' +
      '**由审核流驱动，接口不得直接改**——请求体里出现 status 一律 400（10001）',
    enum: [0, 1, 2, 3, 4, 5],
    example: 0,
  })
  status!: MentorProfileStatus;
}

/**
 * `PUT /mentor/profile` 的入参白名单——**只认这 7 个字段**（红线）。
 *
 * `id` / `personId` / `mentorType` / `status` 一律不收：它们分别由行标识、
 * 身份链（SysUser.username ↔ SyncPerson.login）与审核流决定，接口不得改。
 * 未知字段由全局 `ValidationPipe({ forbidNonWhitelisted: true })` 一律 400 /
 * 10001（src/bootstrap.ts）——不许绕开管道手写白名单解析，也不许为了绕它把
 * `@Body()` 写成 `Record<string, unknown>`。
 *
 * **全部字段可选（增量语义）**：省略 = 不动该列（**内校的 `affiliateOrg` /
 * `socialRoles` 除外，见 R49：恒置 `null`**）；显式 `null` = 清空该列；
 * `researchFields` 传了就整体替换（清空用 `[]`，`null` 不是合法值）。
 * 首次 PUT（建行）时省略的列落 NULL（`researchFields` 落 `[]`）。
 *
 * 校验全部指到具体字段（ERR-06）：超限的报错在 `data.fields` 里点名字段。
 */
export class UpdateMentorProfileDto {
  @ApiPropertyOptional({
    description:
      '指导方向，自由文本数组（Ruling #13：不做字典 / 白名单）。' +
      '每项 **≤ 30 字符**、数组 **≤ 5 项**、允许 `[]`（= 清空）；' +
      '传 `null` 不是合法值（清空请传 []）。省略 = 不动',
    type: [String],
    example: ['创新创业', '人工智能'],
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray({ message: '指导方向必须是字符串数组' })
  @ArrayMaxSize(5, { message: '指导方向最多 5 项' })
  @IsString({ each: true, message: '指导方向每项必须是字符串' })
  @MaxLength(30, { each: true, message: '指导方向每项最多 30 个字符' })
  researchFields?: string[];

  @ApiPropertyOptional({
    type: String,
    description:
      '个人简介，**≤ 2000 字符**（R48），可空；省略 = 不动，null = 清空',
    example: '长期从事……',
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: '个人简介必须是字符串' })
  @MaxLength(2000, { message: '个人简介最多 2000 个字符' })
  summary?: string | null;

  @ApiPropertyOptional({
    type: String,
    description:
      '研究成果，**≤ 2000 字符**（R48），可空；省略 = 不动，null = 清空',
    example: '主持省部级课题 2 项……',
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: '研究成果必须是字符串' })
  @MaxLength(2000, { message: '研究成果最多 2000 个字符' })
  achievements?: string | null;

  @ApiPropertyOptional({
    type: String,
    description:
      '指导经验，**≤ 2000 字符**（R48），可空；省略 = 不动，null = 清空',
    example: '累计指导学生 30 人……',
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: '指导经验必须是字符串' })
  @MaxLength(2000, { message: '指导经验最多 2000 个字符' })
  guidanceExperience?: string | null;

  @ApiPropertyOptional({
    type: String,
    description:
      '合作单位，**≤ 100 字符**，可空。**仅校外导师（mentorType=external）有效**；' +
      '校内导师传了 / 省略都不报错，落库时恒置 NULL（R49）',
    example: '某某研究院',
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: '合作单位必须是字符串' })
  @MaxLength(100, { message: '合作单位最多 100 个字符' })
  affiliateOrg?: string | null;

  @ApiPropertyOptional({
    type: String,
    description:
      '社会任职，**≤ 100 字符**，可空。**仅校外导师（mentorType=external）有效**；' +
      '校内导师传了 / 省略都不报错，落库时恒置 NULL（R49）',
    example: '某某学会理事',
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: '社会任职必须是字符串' })
  @MaxLength(100, { message: '社会任职最多 100 个字符' })
  socialRoles?: string | null;

  @ApiPropertyOptional({
    type: String,
    description:
      '职称 / 资质，自由文本，**≤ 100 字符**（R28），可空。' +
      '**内校 / 外校都有效**（与 affiliateOrg / socialRoles 不同，不置 NULL）；' +
      '省略 = 不动，null = 清空',
    example: '教授',
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: '职称资质必须是字符串' })
  @MaxLength(100, { message: '职称资质最多 100 个字符' })
  professionalTitle?: string | null;
}

/**
 * `PUT /mentor/profile/contact` 的唯一入参。
 *
 * 联系电话不是专业资格，**不走进驻 / 信息修改申请的审核流**：导师本人随时可改。
 * `null` = 清除覆盖、回退显示同步源的手机号；不允许省略（省略 → 400）。
 */
export class UpdateMentorContactDto {
  @ApiProperty({
    type: String,
    description:
      '联系电话，6-20 位，可含数字 / `+` / `-` / 空格 / 括号；' +
      '**传 null 表示清除覆盖**（回退到 SyncPerson.mobile）',
    example: '13800000000',
    nullable: true,
  })
  @ValidateIf((_object, value) => value !== null)
  @IsString({ message: '联系电话必须是字符串' })
  @Matches(/^[0-9+\-\s()]{6,20}$/, {
    message: '联系电话需为 6-20 位数字，可含 + - 空格 括号',
  })
  contactMobile!: string | null;
}
