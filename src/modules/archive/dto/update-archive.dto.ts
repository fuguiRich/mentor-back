import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

/**
 * `PATCH /archives/:id` 的请求体（P4 Task 53 / §6.5）。
 *
 * 只能改 `title` / `summary` / `retentionUntil`——`targetType` / `targetId` /
 * `category` / `core` 都不在字段表里（改了等于换一条归档）。
 *
 * `retentionUntil` 传 `null` 表示「不再自动清理」。**核心材料（`core = 1`）
 * 不允许设置保留期**：R64 的「核心永久保存」由 Service 守住（400 / 10001），
 * DTO 表达不了「这一行是不是核心」。
 */
export class UpdateArchiveDto {
  @ApiPropertyOptional({
    description: '归档标题，1-200 字',
    example: '2026 年省级竞赛获奖成果（已复核）',
  })
  @IsOptional()
  @IsString({ message: 'title 必须是字符串' })
  @Length(1, 200, { message: 'title 长度必须是 1-200 个字符' })
  title?: string;

  @ApiPropertyOptional({
    description: '归档摘要，≤500 字',
    example: '补充说明：证书扫描件已核对',
  })
  @IsOptional()
  @IsString({ message: 'summary 必须是字符串' })
  @MaxLength(500, { message: 'summary 长度不能超过 500 个字符' })
  summary?: string;

  @ApiPropertyOptional({
    description: '保留截止日，YYYY-MM-DD；传 null 取消自动清理',
    type: String,
    nullable: true,
    example: '2031-11-02',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'retentionUntil 必须是 YYYY-MM-DD 或 null',
  })
  retentionUntil?: string | null;

  @ApiPropertyOptional({
    description: '归档附件（SysFile.id 数组，最多 10 个）；传 [] = 清空',
    type: [String],
    example: ['12', '13'],
  })
  @IsOptional()
  @IsArray({ message: 'fileIds 必须是数组' })
  @ArrayMaxSize(10, { message: '归档附件最多 10 个' })
  @IsBigIntId({ each: true, message: 'fileIds 必须是数字 ID 数组' })
  fileIds?: string[];
}
