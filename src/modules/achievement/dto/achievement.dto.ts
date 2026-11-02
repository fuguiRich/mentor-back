import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { toNumberIfNumericString } from '../../appointment/dto/create-appointment.dto';

/** 成果类型（§5.2 原文列举前两类；`3 其他` 兜住不属于前两类的） */
export const ACHIEVEMENT_TYPES = [1, 2, 3] as const;

/** 成果级别（R46：竞赛获奖与项目立项**共用**这把标尺） */
export const ACHIEVEMENT_LEVELS = [1, 2, 3, 4, 5] as const;

/**
 * `POST /mentors/:mentorId/achievements` 的请求体（P3 Task 36 / §5.2）。
 *
 * 导师本人登记、登记即生效（R45）——没有审核状态。§5.4 的「成果关联归档」
 * 归 P4，本期只为考核初评提供输入。
 *
 * `proofFileId` 是 `SysFile.id`，**裸列无外键**：文件被多处引用，删成果不该
 * 连带删文件。这里**不校验文件是否存在**——上传发生在登记之前，没有归属可断言；
 * 前端展示时按 id 去取，取不到就是「佐证已失效」，比在登记时编一个归属规则诚实。
 */
export class CreateAchievementDto {
  @ApiProperty({
    description: '成果类型：1 竞赛获奖 / 2 项目立项 / 3 其他',
    enum: ACHIEVEMENT_TYPES,
    example: 1,
  })
  @Transform(toNumberIfNumericString)
  @IsInt({ message: 'type 必须是 1 / 2 / 3' })
  @IsIn(ACHIEVEMENT_TYPES, { message: 'type 必须是 1 / 2 / 3' })
  type!: number;

  @ApiProperty({
    description: '成果名称，1-200 字',
    example: '中国国际大学生创新大赛省级银奖',
  })
  @IsString({ message: 'title 必须是字符串' })
  @Length(1, 200, { message: 'title 长度必须是 1-200 个字符' })
  title!: string;

  @ApiProperty({
    description: '级别：1 国家级 / 2 省级 / 3 市级 / 4 校级 / 5 院级',
    enum: ACHIEVEMENT_LEVELS,
    example: 2,
  })
  @Transform(toNumberIfNumericString)
  @IsInt({ message: 'level 必须是 1-5' })
  @IsIn(ACHIEVEMENT_LEVELS, { message: 'level 必须是 1-5' })
  level!: number;

  @ApiProperty({
    description: '获奖 / 立项日期（ISO 8601，只取日期部分）',
    example: '2026-09-15',
  })
  @IsString({ message: 'awardedAt 必须是 ISO 8601 日期字符串' })
  @IsISO8601(
    { strict: true },
    { message: 'awardedAt 必须是合法的 ISO 8601 日期' },
  )
  awardedAt!: string;

  @ApiPropertyOptional({
    description: '说明，≤1000 字',
    example: '团队 5 人，本人为第一指导教师。',
    type: String,
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: 'description 必须是字符串' })
  @Length(0, 1000, { message: 'description 不能超过 1000 个字符' })
  description?: string | null;

  @ApiPropertyOptional({
    description: '佐证文件 ID（SysFile.id，BIGINT 对外字符串）；不传为 null',
    example: '12',
    type: String,
    nullable: true,
  })
  @IsOptional()
  @IsBigIntId({ message: 'proofFileId 必须是合法的数字 ID' })
  proofFileId?: string | null;
}

/**
 * `PATCH /mentors/:mentorId/achievements/:achievementId` 的请求体。
 *
 * **没有 `type`**（R45 的落地方式）：改了类型等于换了一条成果，
 * 统计口径（竞赛获奖 vs 项目立项）会跟着变，历史报表无法解释。
 * 真要换类型就删了重建。
 */
export class UpdateAchievementDto {
  @ApiPropertyOptional({
    description: '成果名称，1-200 字',
    example: '省级银奖',
  })
  @IsOptional()
  @IsString({ message: 'title 必须是字符串' })
  @Length(1, 200, { message: 'title 长度必须是 1-200 个字符' })
  title?: string;

  @ApiPropertyOptional({
    description: '级别：1 国家级 / 2 省级 / 3 市级 / 4 校级 / 5 院级',
    enum: ACHIEVEMENT_LEVELS,
    example: 2,
  })
  @IsOptional()
  @Transform(toNumberIfNumericString)
  @IsInt({ message: 'level 必须是 1-5' })
  @IsIn(ACHIEVEMENT_LEVELS, { message: 'level 必须是 1-5' })
  level?: number;

  @ApiPropertyOptional({
    description: '获奖 / 立项日期（ISO 8601，只取日期部分）',
    example: '2026-09-15',
  })
  @IsOptional()
  @IsString({ message: 'awardedAt 必须是 ISO 8601 日期字符串' })
  @IsISO8601(
    { strict: true },
    { message: 'awardedAt 必须是合法的 ISO 8601 日期' },
  )
  awardedAt?: string;

  @ApiPropertyOptional({
    description: '说明，≤1000 字；传 null 表示清空',
    type: String,
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: 'description 必须是字符串' })
  @Length(0, 1000, { message: 'description 不能超过 1000 个字符' })
  description?: string | null;

  @ApiPropertyOptional({
    description: '佐证文件 ID（SysFile.id）；传 null 表示清空',
    type: String,
    nullable: true,
  })
  @IsOptional()
  @IsBigIntId({ message: 'proofFileId 必须是合法的数字 ID' })
  proofFileId?: string | null;
}

/**
 * `GET /mentors/:mentorId/achievements` 的查询参数。
 *
 * `year` 是四位年份，区间按 `[YYYY-01-01, (YYYY+1)-01-01)` 半开（R47 同一口径）——
 * 不提供 `from` / `to`：成果按年筛选足够，多两个参数就多一套前端状态。
 */
export class QueryAchievementDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '成果类型：1 竞赛获奖 / 2 项目立项 / 3 其他',
    enum: ACHIEVEMENT_TYPES,
  })
  @IsOptional()
  @Transform(toNumberIfNumericString)
  @IsInt()
  @IsIn(ACHIEVEMENT_TYPES)
  type?: number;

  @ApiPropertyOptional({
    description: '级别：1 国家级 / 2 省级 / 3 市级 / 4 校级 / 5 院级',
    enum: ACHIEVEMENT_LEVELS,
  })
  @IsOptional()
  @Transform(toNumberIfNumericString)
  @IsInt()
  @IsIn(ACHIEVEMENT_LEVELS)
  level?: number;

  @ApiPropertyOptional({
    description: '获奖 / 立项年份（四位）',
    example: 2026,
  })
  @IsOptional()
  @Transform(toNumberIfNumericString)
  @IsInt({ message: 'year 必须是四位年份' })
  @Min(1900, { message: 'year 必须是四位年份' })
  @Max(9999, { message: 'year 必须是四位年份' })
  year?: number;
}
