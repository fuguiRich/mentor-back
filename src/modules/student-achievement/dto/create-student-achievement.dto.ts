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
import { toNumberIfNumericString } from '../../appointment/dto/create-appointment.dto';

/** 学生成果类型：1 竞赛获奖 / 2 项目立项 / 3 其他（同导师成果） */
export const STUDENT_ACHIEVEMENT_TYPES = [1, 2, 3] as const;

/** 级别：1 国家级 / 2 省级 / 3 市级 / 4 校级 / 5 院级 */
export const STUDENT_ACHIEVEMENT_LEVELS = [1, 2, 3, 4, 5] as const;

/**
 * `POST /student-achievements` 的请求体（P5 Task 59 / §5.4）。
 *
 * `mentorProfileId` 可省略：先建成果、后 `PATCH .../link` 人工关联。
 * 关联时同事务生成一条导师 `Achievement` 并落归档。
 */
export class CreateStudentAchievementDto {
  @ApiProperty({
    description: '学生（SyncPerson.id，BIGINT 对外字符串）',
    example: '5',
  })
  @IsBigIntId({ message: 'studentPersonId 必须是合法的数字 ID' })
  studentPersonId!: string;

  @ApiPropertyOptional({
    description: '关联的导师档案 ID；省略则先建未关联成果',
    example: '1',
  })
  @IsOptional()
  @IsBigIntId({ message: 'mentorProfileId 必须是合法的数字 ID' })
  mentorProfileId?: string;

  @ApiProperty({
    description: '成果类型：1 竞赛获奖 / 2 项目立项 / 3 其他',
    enum: STUDENT_ACHIEVEMENT_TYPES,
    example: 1,
  })
  @Transform(toNumberIfNumericString)
  @IsInt({ message: 'type 必须是 1 / 2 / 3' })
  @IsIn([...STUDENT_ACHIEVEMENT_TYPES], { message: 'type 必须是 1 / 2 / 3' })
  type!: number;

  @ApiProperty({ description: '成果名称，1-200 字', example: '省级竞赛金奖' })
  @IsString({ message: 'title 必须是字符串' })
  @Length(1, 200, { message: 'title 长度必须是 1-200 个字符' })
  title!: string;

  @ApiProperty({
    description: '级别：1 国家级 / 2 省级 / 3 市级 / 4 校级 / 5 院级',
    enum: STUDENT_ACHIEVEMENT_LEVELS,
    example: 2,
  })
  @Transform(toNumberIfNumericString)
  @IsInt({ message: 'level 必须是 1-5' })
  @IsIn([...STUDENT_ACHIEVEMENT_LEVELS], { message: 'level 必须是 1-5' })
  @Min(1)
  @Max(5)
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
    description: '佐证文件 ID（SysFile.id，裸列无外键）',
    example: '8',
  })
  @IsOptional()
  @IsBigIntId({ message: 'proofFileId 必须是合法的数字 ID' })
  proofFileId?: string;
}
