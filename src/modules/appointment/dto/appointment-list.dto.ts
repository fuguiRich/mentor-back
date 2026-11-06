import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional } from 'class-validator';
import { PageResponseDto } from '../../../common/dto/page-response.dto';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { AppointmentResponseDto } from './appointment-response.dto';
import {
  APPOINTMENT_STATUS,
  APPOINTMENT_TYPES,
} from './create-appointment.dto';

/** 合法的 `status` 取值（0-9，R12 的全集），DTO 与文档共用 */
export const APPOINTMENT_STATUS_VALUES: readonly number[] =
  Object.values(APPOINTMENT_STATUS);

/**
 * `GET /appointments` 的查询参数（Task 30）。
 *
 * 六个参数**全部可选、彼此 AND**：`status` / `type` 是等值过滤，
 * `from` / `to` 按 `requestedTime` 收时间范围，`page` / `pageSize` 继承
 * {@link PaginationQueryDto}（`pageSize` 上限 100，DTO-10）。
 *
 * `status` / `type` 用 `@Type(() => Number)` + `@IsInt` + `@IsIn`：
 * 查询串里它们只会是字符串，`Number('true')` 是 `NaN`，布尔值不会像 JSON
 * 请求体那样蒙混成 `1`。越界（`status=99` / `type=6` / `type=0`）一律
 * **400 / 10001**，`data.fields` 点名对应字段。
 */
export class QueryAppointmentDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description:
      '预约状态：0 PENDING | 1 CONFIRMED | 2 IN_PROGRESS | 3 RECORD_SUBMITTED | ' +
      '4 STUDENT_CONFIRMED | 5 DISPUTED | 6 COMPLETED | 7 REJECTED | ' +
      '8 CANCELLED | 9 EXPIRED；不传 = 不限。越界 → 400 / 10001',
    enum: APPOINTMENT_STATUS_VALUES,
    example: APPOINTMENT_STATUS.PENDING,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'status 必须是 0-9 的整数' })
  @IsIn(APPOINTMENT_STATUS_VALUES, { message: 'status 必须是 0-9 的整数' })
  status?: number;

  @ApiPropertyOptional({
    description:
      '预约类型：1 双创竞赛指导 / 2 科研项目指导 / 3 创业实践指导 / ' +
      '4 论文·专利指导 / 5 其他双创指导；不传 = 不限。越界 → 400 / 10001',
    enum: APPOINTMENT_TYPES,
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'type 必须是 1-5 的整数' })
  @IsIn(APPOINTMENT_TYPES, { message: 'type 必须是 1-5 的整数' })
  type?: number;

  @ApiPropertyOptional({
    description:
      '预约时间下界（含），按 `requestedTime` 过滤。ISO 8601；纯日期按 UTC 零点。' +
      '与 `to` 同时给出时必须不晚于 `to`，否则 400 / 10001',
    example: '2026-01-01',
  })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'from 必须是合法的 ISO 8601 时间' })
  from?: string;

  @ApiPropertyOptional({
    description:
      '预约时间上界（含），按 `requestedTime` 过滤。ISO 8601；纯日期表示当天' +
      ' 23:59:59.999（UTC）。与 `from` 同时给出时必须不早于 `from`，否则 400 / 10001',
    example: '2026-12-31',
  })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'to 必须是合法的 ISO 8601 时间' })
  to?: string;
}

/**
 * 列表项里的「学生基本信息」（需求 §4.3）。导师处理预约时必须看见学生姓名，
 * 否则列表不可用——四个字段全部来自 `appointment.student` 联查，客户端改不到。
 *
 * `personId` 是 BIGINT，对外一律字符串（RES-08）；`orgUnitName` 来自
 * `sync_org_unit.name`（申请人所在组织）。
 */
export class AppointmentStudentDto {
  @ApiProperty({
    description: '学生（SyncPerson.id，BIGINT 对外字符串）',
    example: '2',
  })
  personId!: string;

  @ApiProperty({ description: '学号（登录名）', example: 'S001' })
  login!: string;

  @ApiProperty({ description: '学生姓名', example: '陈一鸣' })
  realName!: string;

  @ApiProperty({
    description: '申请人所在组织名称（sync_org_unit.name）',
    example: '软件学院',
  })
  orgUnitName!: string;
}

/**
 * 列表项里的「导师基本信息」。`mentorProfileId` 是 BIGINT，对外字符串（RES-08）。
 */
export class AppointmentMentorDto {
  @ApiProperty({
    description: '导师档案 ID（MentorProfile.id，BIGINT 对外字符串）',
    example: '1',
  })
  mentorProfileId!: string;

  @ApiProperty({ description: '导师姓名', example: '张明远' })
  realName!: string;

  @ApiProperty({
    description: '导师所在组织名称（sync_org_unit.name）',
    example: '计算机学院',
  })
  orgUnitName!: string;
}

/**
 * 列表项的响应形状（RES-04：显式映射，不序列化实体）。
 *
 * **继承 {@link AppointmentResponseDto}**——预约本身的 14 个字段一个不复制，
 * 只在它之上加 `student` / `mentor` 两项联查信息。
 */
export class AppointmentListItemDto extends AppointmentResponseDto {
  @ApiProperty({
    description: '申请人基本信息（由 appointment.student_id 联查）',
    type: () => AppointmentStudentDto,
  })
  student!: AppointmentStudentDto;

  @ApiProperty({
    description: '被预约的导师基本信息（由 appointment.mentor_id 联查）',
    type: () => AppointmentMentorDto,
  })
  mentor!: AppointmentMentorDto;
}

/**
 * 详情里的「学生信息」：列表项的四项 + 专业 / 行政班级 / 联系电话。
 * 后三项与 `GuidanceRecordStudentDto` 同形，可空（同步数据未提供时为 null）。
 */
export class AppointmentDetailStudentDto extends AppointmentStudentDto {
  @ApiProperty({
    description: '专业；同步数据未提供时为 null',
    type: String,
    nullable: true,
    example: '软件工程',
  })
  major!: string | null;

  @ApiProperty({
    description: '行政班级；同步数据未提供时为 null',
    type: String,
    nullable: true,
    example: '软工 2023-1 班',
  })
  className!: string | null;

  @ApiProperty({
    description: '联系电话；同步数据未提供时为 null',
    type: String,
    nullable: true,
    example: '13800000000',
  })
  mobile!: string | null;
}

/**
 * `GET /appointments/:id` 的响应形状：列表项的全部字段 + 更全的学生信息。
 *
 * `student` 用 `declare` 重声明而不是重新赋值：运行时仍是同一个字段，
 * 只是把文档里的元素类型换成 {@link AppointmentDetailStudentDto}
 * （同 `MentorSearchPageResponseDto.list` 的写法）。
 */
export class AppointmentDetailDto extends AppointmentListItemDto {
  @ApiProperty({
    description: '申请人完整信息（列表项的四项 + 专业 / 班级 / 电话）',
    type: () => AppointmentDetailStudentDto,
  })
  declare student: AppointmentDetailStudentDto;
}

/**
 * 分页列表响应（RES-06：`{ list, total, page, pageSize }`）。
 *
 * 重写 `list` 的注解：Swagger 推断不出泛型元素类型，不重写文档里 `list`
 * 就是空数组。`declare` 是编译要求（同 mentor-search / mentor-application）。
 */
export class AppointmentListResponseDto extends PageResponseDto<AppointmentListItemDto> {
  @ApiProperty({
    type: () => [AppointmentListItemDto],
    description:
      '当前页的预约（按 createdAt 倒序，同一毫秒再按 id 倒序）；' +
      '`total` 是**过滤后的总数**，不是当前页条数',
  })
  declare list: AppointmentListItemDto[];
}
