import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { ARCHIVE_CATEGORIES, ARCHIVE_TARGET_TYPES } from '../archive.constants';

/**
 * `GET /archives` 的查询参数（P4 Task 52 / §4.7）。
 *
 * `from` / `to` 按**归档时间**（`archived_at`）过滤，闭区间；两者必须成对出现
 * （只给一个 → 400 / 10001）。`deptId` 只有 `all` 范围能传，学院管理员传了
 * → 403 / 10003。
 */
export class ListArchiveQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '按归属导师快照过滤（BIGINT 对外字符串）',
    example: '1',
  })
  @IsOptional()
  @Matches(/^\d+$/, { message: 'mentorId 必须是合法的数字 ID' })
  mentorId?: string;

  @ApiPropertyOptional({
    description: '按归属学院快照过滤（仅双创学院可用）',
    example: '2',
  })
  @IsOptional()
  @Matches(/^\d+$/, { message: 'deptId 必须是合法的数字 ID' })
  deptId?: string;

  @ApiPropertyOptional({
    description: '归档分类',
    enum: ARCHIVE_CATEGORIES,
    example: 'assessment',
  })
  @IsOptional()
  @IsIn([...ARCHIVE_CATEGORIES], {
    message: `category 只能是 ${ARCHIVE_CATEGORIES.join(' / ')}`,
  })
  category?: string;

  @ApiPropertyOptional({
    description: '归档目标类型',
    enum: ARCHIVE_TARGET_TYPES,
    example: 'Assessment',
  })
  @IsOptional()
  @IsIn([...ARCHIVE_TARGET_TYPES], {
    message: `targetType 只能是 ${ARCHIVE_TARGET_TYPES.join(' / ')}`,
  })
  targetType?: string;

  @ApiPropertyOptional({
    description: '归档时间起（含），YYYY-MM-DD；与 to 成对出现',
    example: '2026-01-01',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from 必须是 YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({
    description: '归档时间止（含），YYYY-MM-DD；与 from 成对出现',
    example: '2026-12-31',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to 必须是 YYYY-MM-DD' })
  to?: string;
}
