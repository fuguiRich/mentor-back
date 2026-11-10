import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';
import {
  ARCHIVE_TARGET_TYPES,
  MANUAL_ARCHIVE_CATEGORIES,
} from '../archive.constants';

/**
 * `POST /archives` 的请求体（P4 Task 52 / §4.7）。
 *
 * **`core` 不在字段表里**：手工归档一律非核心（`core = 0`），由 Service 定。
 * 请求体带 `core` 会被全局 `forbidNonWhitelisted` 挡成 **400 / 10001**——
 * 核心 / 非核心决定「永久保存还是到期清理」，不能让调用方自己声明。
 *
 * `mentorId` / `deptId` 是**快照**（裸列无外键）：归档时写死，之后导师调岗
 * 不影响历史检索。`deptId` 不传时，学院管理员就检索不到这一条——这是刻意的
 * fail-closed，不替调用方猜归属。
 */
export class CreateArchiveDto {
  @ApiProperty({
    description: '归档目标类型',
    enum: ARCHIVE_TARGET_TYPES,
    example: 'Achievement',
  })
  @IsIn([...ARCHIVE_TARGET_TYPES], {
    message: `targetType 只能是 ${ARCHIVE_TARGET_TYPES.join(' / ')}`,
  })
  targetType!: string;

  @ApiProperty({
    description: '归档目标 ID（弱关联，不校验存在性），1-50 字符',
    example: '9001',
  })
  @IsString({ message: 'targetId 必须是字符串' })
  @Length(1, 50, { message: 'targetId 长度必须是 1-50 个字符' })
  targetId!: string;

  @ApiProperty({
    description: '归档标题快照，1-200 字',
    example: '2026 年省级竞赛获奖成果',
  })
  @IsString({ message: 'title 必须是字符串' })
  @Length(1, 200, { message: 'title 长度必须是 1-200 个字符' })
  title!: string;

  @ApiProperty({
    description: '归档分类（手工归档只允许这三类）',
    enum: MANUAL_ARCHIVE_CATEGORIES,
    example: 'achievement',
  })
  @IsIn([...MANUAL_ARCHIVE_CATEGORIES], {
    message: `category 只能是 ${MANUAL_ARCHIVE_CATEGORIES.join(' / ')}`,
  })
  category!: string;

  @ApiPropertyOptional({
    description: '归属导师快照（MentorProfile.id，BIGINT 对外字符串）',
    example: '1',
  })
  @IsOptional()
  @Matches(/^\d+$/, { message: 'mentorId 必须是合法的数字 ID' })
  mentorId?: string;

  @ApiPropertyOptional({
    description: '归属学院快照（SysDept.id，BIGINT 对外字符串）',
    example: '2',
  })
  @IsOptional()
  @Matches(/^\d+$/, { message: 'deptId 必须是合法的数字 ID' })
  deptId?: string;

  @ApiPropertyOptional({
    description: '归档摘要，≤500 字',
    example: '按 §4.7 手工归档的非核心材料',
  })
  @IsOptional()
  @IsString({ message: 'summary 必须是字符串' })
  @MaxLength(500, { message: 'summary 长度不能超过 500 个字符' })
  summary?: string;

  @ApiPropertyOptional({
    description:
      '归档附件（SysFile.id 数组，最多 10 个）；先走 `POST /files` 上传',
    type: [String],
    example: ['12', '13'],
  })
  @IsOptional()
  @IsArray({ message: 'fileIds 必须是数组' })
  @ArrayMaxSize(10, { message: '归档附件最多 10 个' })
  @IsBigIntId({ each: true, message: 'fileIds 必须是数字 ID 数组' })
  fileIds?: string[];
}
