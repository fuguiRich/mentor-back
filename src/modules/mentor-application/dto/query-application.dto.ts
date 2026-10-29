import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';
import { PageResponseDto } from '../../../common/dto/page-response.dto';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { MentorApplicationResponseDto } from './mentor-application-response.dto';
import {
  MENTOR_APPLICATION_STATUS,
  MENTOR_APPLICATION_TYPE,
} from './mentor-application-response.dto';

/** `MentorApplication.status` 的全部合法值（@IsIn 与 OpenAPI enum 共用） */
const STATUS_VALUES = Object.values(MENTOR_APPLICATION_STATUS) as number[];

/** `MentorApplication.type` 的全部合法值 */
const TYPE_VALUES = Object.values(MENTOR_APPLICATION_TYPE) as number[];

/**
 * `:id` 路径参数（college-review / sc-review / withdraw / GET :id 共用）。
 * `@ApiProperty` 不能省：@nestjs/swagger 只展开带它的属性，少了它 OpenAPI 里
 * 没有 path 参数（同 oplog.dto.ts 的同名注释）。
 */
export class MentorApplicationParamDto {
  @ApiProperty({ description: '申请行 ID', example: '1' })
  @IsBigIntId({ message: '入驻申请 ID 必须是正整数字符串' })
  id!: string;
}

/**
 * `GET /mentor-applications` 的查询：分页 + `status` / `type` 筛选。
 * 列表的行级范围不来自入参（`@DataScope('all')` 天花板 + 角色 data_scope 收窄），
 * 请求体 / query 里**不收**任何范围参数。
 */
export class QueryMentorApplicationDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description:
      '申请状态筛选：0 DRAFT | 1 SUBMITTED | 2 COLLEGE_REVIEWING | 3 COLLEGE_REJECTED | ' +
      '4 SC_REVIEWING | 5 SC_REJECTED | 6 APPROVED | 7 WITHDRAWN；不传表示全部',
    enum: STATUS_VALUES,
    example: 2,
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn(STATUS_VALUES, { message: 'status 必须是 0-7 的申请状态值' })
  status?: number;

  @ApiPropertyOptional({
    description:
      '申请类型筛选：1 ONBOARD 入驻 | 2 PROFILE_CHANGE 信息修改；不传表示全部',
    enum: TYPE_VALUES,
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn(TYPE_VALUES, { message: 'type 必须是 1 或 2' })
  type?: number;
}

/**
 * 分页列表响应。重写 list 的注解：Swagger 推断不出泛型元素类型
 * （spec 第 6 节 ⑤）；`declare` 是编译要求（target ES2023 下
 * useDefineForClassFields 为 true，同 oplog.dto.ts）。
 */
export class MentorApplicationPageResponseDto extends PageResponseDto<MentorApplicationResponseDto> {
  @ApiProperty({
    type: () => [MentorApplicationResponseDto],
    description: '当前页的入驻申请',
  })
  declare list: MentorApplicationResponseDto[];
}
