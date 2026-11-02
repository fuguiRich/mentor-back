import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Min } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { toNumberIfNumericString } from '../../appointment/dto/create-appointment.dto';
import { STUDENT_ACHIEVEMENT_TYPES } from './create-student-achievement.dto';

/** `GET /student-achievements` 的查询参数 */
export class QueryStudentAchievementDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '按学生过滤（SyncPerson.id，BIGINT 对外字符串）',
    example: '5',
  })
  @IsOptional()
  @Matches(/^\d+$/, { message: 'studentPersonId 必须是合法的数字 ID' })
  studentPersonId?: string;

  @ApiPropertyOptional({
    description: '按关联导师过滤（MentorProfile.id，BIGINT 对外字符串）',
    example: '1',
  })
  @IsOptional()
  @Matches(/^\d+$/, { message: 'mentorId 必须是合法的数字 ID' })
  mentorId?: string;

  @ApiPropertyOptional({
    description: '成果类型：1 竞赛获奖 / 2 项目立项 / 3 其他',
    enum: STUDENT_ACHIEVEMENT_TYPES,
    example: 1,
  })
  @IsOptional()
  @Transform(toNumberIfNumericString)
  @IsInt()
  @IsIn([...STUDENT_ACHIEVEMENT_TYPES], { message: 'type 必须是 1 / 2 / 3' })
  type?: number;

  @ApiPropertyOptional({
    description: '获奖 / 立项年份（四位）',
    example: 2026,
  })
  @IsOptional()
  @Transform(toNumberIfNumericString)
  @IsInt()
  @Min(1900)
  year?: number;

  @ApiPropertyOptional({
    description: '关联状态：0 未关联 / 1 已关联；不传为全部',
    enum: [0, 1],
    example: 1,
  })
  @IsOptional()
  @Transform(toNumberIfNumericString)
  @IsInt()
  @IsIn([0, 1], { message: 'linked 只能是 0 或 1' })
  linked?: number;
}
