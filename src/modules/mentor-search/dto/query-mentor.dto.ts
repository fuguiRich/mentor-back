import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';
import { PageResponseDto } from '../../../common/dto/page-response.dto';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import {
  MENTOR_SEARCH_TYPES,
  MentorSearchItemResponseDto,
} from './mentor-search-response.dto';

/** `weekday` 的合法区间（1 周一 … 7 周日），越界 → 400 / 10001 */
export const MENTOR_SEARCH_WEEKDAY_MIN = 1;
export const MENTOR_SEARCH_WEEKDAY_MAX = 7;

/**
 * `GET /mentors` 的查询参数（Task 22，需求 §2.1 的检索条件逐条落）。
 *
 * **全部可选、彼此 AND**；一个都不传就是「全部已生效导师」。
 * 没有 `deptIds` / `scope` 这类范围参数——检索本就跨院，行级范围不来自入参
 * （天花板 `@DataScope('all')`，服务端不按调用者的角色范围收窄）。
 */
export class QueryMentorDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '导师姓名，模糊匹配 SyncPerson.realName',
    example: '张',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  name?: string;

  @ApiPropertyOptional({
    description:
      '导师类型：internal 校内 / external 校外（由 SyncPerson.personType 推导）；' +
      '其余取值 → 400 / 10001',
    enum: MENTOR_SEARCH_TYPES,
    example: 'internal',
  })
  @IsOptional()
  @IsIn(MENTOR_SEARCH_TYPES, {
    message: 'mentorType 只能是 internal 或 external',
  })
  mentorType?: (typeof MENTOR_SEARCH_TYPES)[number];

  @ApiPropertyOptional({
    description:
      '指导方向，**精确项匹配**：MentorProfile.researchFields（JSON 数组）包含该值。' +
      '传部分字符串（如「人工」）不算命中，必须与数组中的某一项完全相等',
    example: '人工智能',
  })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  researchField?: string;

  @ApiPropertyOptional({
    description: '职称 / 资质，模糊匹配 MentorProfile.professionalTitle（R28）',
    example: '教授',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  professionalTitle?: string;

  @ApiPropertyOptional({
    description:
      '可指导时段：1 周一 … 7 周日。只返回该周几有**开放**（status=1）且未软删时段的导师；' +
      '越界 → 400 / 10001',
    enum: [1, 2, 3, 4, 5, 6, 7],
    example: 3,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'weekday 必须是 1-7 的整数' })
  @Min(MENTOR_SEARCH_WEEKDAY_MIN, { message: 'weekday 必须是 1-7 的整数' })
  @Max(MENTOR_SEARCH_WEEKDAY_MAX, { message: 'weekday 必须是 1-7 的整数' })
  weekday?: number;

  @ApiPropertyOptional({
    description:
      '所属学院：SyncPerson.orgUnitId → SyncOrgUnit.deptId，**精确**匹配（BIGINT 字符串）',
    example: '1',
  })
  @IsOptional()
  @IsBigIntId({ message: '学院 ID 必须是合法的数字 ID' })
  deptId?: string;

  @ApiPropertyOptional({
    description:
      '通用搜索框，模糊匹配导师姓名（realName）/ 个人简介（summary）。' +
      '**不匹配指导方向**（R29）：方向请用 researchField 精确筛选',
    example: '张明远',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  keyword?: string;
}

/**
 * `GET /mentors/:id` 的路径参数：`:id` 是 `MentorProfile.id`。
 * 校验用 `@IsBigIntId()`（`1.5` / `-1` / 超界都挡在 400，不进 `BigInt()`）。
 */
export class MentorSearchParamDto {
  @ApiProperty({
    description: '导师专业档案 ID（BIGINT 对外字符串）',
    example: '1',
  })
  @IsBigIntId({ message: '档案 ID 必须是合法的数字 ID' })
  id!: string;
}

/**
 * 分页列表响应（RES-06）。重写 `list` 的注解：Swagger 推断不出泛型元素类型；
 * `declare` 是编译要求（同 mentor-application / oplog 的同类 DTO）。
 */
export class MentorSearchPageResponseDto extends PageResponseDto<MentorSearchItemResponseDto> {
  @ApiProperty({
    type: () => [MentorSearchItemResponseDto],
    description: '当前页的导师（按档案 ID 升序）',
  })
  declare list: MentorSearchItemResponseDto[];
}
