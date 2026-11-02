import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { toNumberIfNumericString } from '../../appointment/dto/create-appointment.dto';

export const MENTOR_TYPE_FILTERS = ['internal', 'external'] as const;

/**
 * 统计类接口的公共查询参数（P4 Task 45 起）。
 *
 * 时间维度二选一（R70）：
 * - `period`：学期 `YYYY-S`（S=1/2），或历史四位年份（全年，只读兼容）；
 * - `from` / `to`：`YYYY-MM-DD`，**闭区间**转成 `[from 00:00, to+1d 00:00)`；
 * - 都不传 → 当前学期；
 * - **同时传 `period` 与 `from`/`to` → 400 / 10001**：两种口径打架时没有正确答案。
 *
 * `deptId` 只有 `all` 范围（双创学院）能传，学院管理员传了 → 403 / 10003。
 */
export class StatsQueryDto {
  @ApiPropertyOptional({
    description: '考核周期：`YYYY-S`（S=1/2）或历史四位年份',
    example: '2026-1',
  })
  @IsOptional()
  @Matches(/^\d{4}(-[12])?$/, {
    message: 'period 必须是 YYYY-S（S=1/2）或四位年份',
  })
  period?: string;

  @ApiPropertyOptional({
    description: '起始日期（含），YYYY-MM-DD；与 period 互斥',
    example: '2026-01-01',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from 必须是 YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({
    description: '结束日期（含），YYYY-MM-DD；与 period 互斥',
    example: '2026-12-31',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to 必须是 YYYY-MM-DD' })
  to?: string;

  @ApiPropertyOptional({
    description: '限定部门（仅双创学院可用，BIGINT 对外字符串）',
    example: '2',
  })
  @IsOptional()
  @Matches(/^\d+$/, { message: 'deptId 必须是合法的数字 ID' })
  deptId?: string;

  @ApiPropertyOptional({
    description: '导师类型：`internal` 校内 / `external` 校外',
    enum: MENTOR_TYPE_FILTERS,
  })
  @IsOptional()
  @IsIn(MENTOR_TYPE_FILTERS, {
    message: 'mentorType 只能是 internal 或 external',
  })
  mentorType?: 'internal' | 'external';

  @ApiPropertyOptional({
    description: '限定导师（指导统计用，MentorProfile.id，BIGINT 对外字符串）',
    example: '1',
  })
  @IsOptional()
  @Matches(/^\d+$/, { message: 'mentorId 必须是合法的数字 ID' })
  mentorId?: string;

  @ApiPropertyOptional({
    description:
      '预约类型（指导统计用）：1 双创竞赛 / 2 科研项目 / 3 创业实践 / ' +
      '4 论文·专利 / 5 其他',
    example: 1,
  })
  @IsOptional()
  @Transform(toNumberIfNumericString)
  @IsInt()
  @IsIn([1, 2, 3, 4, 5], { message: 'type 必须是 1-5' })
  type?: number;

  @ApiPropertyOptional({
    description: '页码（下钻列表用），从 1 开始',
    example: 1,
  })
  @IsOptional()
  @Transform(toNumberIfNumericString)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    description: '每页条数（下钻列表用），最大 100',
    example: 20,
  })
  @IsOptional()
  @Transform(toNumberIfNumericString)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
