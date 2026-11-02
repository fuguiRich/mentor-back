import { ApiProperty } from '@nestjs/swagger';
import { Transform, type TransformFnParams } from 'class-transformer';
import {
  IsISO8601,
  IsIn,
  IsInt,
  IsString,
  Length,
  Validate,
} from 'class-validator';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';
import { IsDateBoundary } from '../../../common/decorators/is-date-boundary.validator';

/**
 * 只把「数字字符串」转成数字，其余原样交给校验。
 *
 * **不用 `@Type(() => Number)`**：`Number(true)` 是 `1`，布尔值会一路蒙混过
 * `@IsIn([1..5])`；`Number('x')` 是 `NaN`，报错也会退化成「不是 1-5 的整数」。
 * 这里保留「客户端把数字写成字符串」的兼容（`"3"` → `3`），而 `true` /
 * `"3.5"` / `"x"` 都原样留下，由 `@IsInt()` 拦掉。
 *
 * 导出供同模块的 `SubmitGuidanceRecordDto.mode` 复用（Task 26）——两处的
 * `mode` 取值相同，转换口径也必须相同。
 */
export function toNumberIfNumericString({ value }: TransformFnParams): unknown {
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number(value);
  }
  return value;
}

/**
 * 预约的 5 类（R11，需求 §2.2 逐字）：
 * 1 双创竞赛指导 / 2 科研项目指导 / 3 创业实践指导 / 4 论文·专利指导 / 5 其他双创指导。
 */
export const APPOINTMENT_TYPE = {
  COMPETITION: 1,
  RESEARCH_PROJECT: 2,
  ENTREPRENEURSHIP: 3,
  PAPER_PATENT: 4,
  OTHER: 5,
} as const;

/** 合法的 type 取值（1-5），DTO 与文档共用 */
export const APPOINTMENT_TYPES: readonly number[] = [
  APPOINTMENT_TYPE.COMPETITION,
  APPOINTMENT_TYPE.RESEARCH_PROJECT,
  APPOINTMENT_TYPE.ENTREPRENEURSHIP,
  APPOINTMENT_TYPE.PAPER_PATENT,
  APPOINTMENT_TYPE.OTHER,
];

/** 对接方式（R25 / 需求 §2.2）：1 线上 / 2 线下 */
export const APPOINTMENT_MODE = {
  ONLINE: 1,
  OFFLINE: 2,
} as const;

/** 合法的 mode 取值（1-2） */
export const APPOINTMENT_MODES: readonly number[] = [
  APPOINTMENT_MODE.ONLINE,
  APPOINTMENT_MODE.OFFLINE,
];

/**
 * 预约状态机（R12）。**终态 = 6 / 7 / 8 / 9**，其余都是未终态——
 * 时段占用与「同学生同导师去重」两条守卫只数未终态的行。
 */
export const APPOINTMENT_STATUS = {
  PENDING: 0,
  CONFIRMED: 1,
  IN_PROGRESS: 2,
  RECORD_SUBMITTED: 3,
  STUDENT_CONFIRMED: 4,
  DISPUTED: 5,
  COMPLETED: 6,
  REJECTED: 7,
  CANCELLED: 8,
  EXPIRED: 9,
} as const;

/** 未终态 = {0,1,2,3,4,5}；6/7/8/9 是终态，不再占用时段、不阻断再次预约 */
export const NON_TERMINAL_APPOINTMENT_STATUSES: readonly number[] = [
  APPOINTMENT_STATUS.PENDING,
  APPOINTMENT_STATUS.CONFIRMED,
  APPOINTMENT_STATUS.IN_PROGRESS,
  APPOINTMENT_STATUS.RECORD_SUBMITTED,
  APPOINTMENT_STATUS.STUDENT_CONFIRMED,
  APPOINTMENT_STATUS.DISPUTED,
];

/**
 * 学生可取消的出发态（R18）：`0 PENDING` / `1 CONFIRMED` → `8 CANCELLED`。
 *
 * **一处定义、两处引用**：Service 的预检（给出 409 的语义）与 Repository 的
 * 条件更新 `where` 用的是同一个常量。写两份的话，放宽其中一处就会留下
 * 「预检放行、落库拒绝」或反过来的半截契约。
 */
export const CANCELLABLE_APPOINTMENT_STATUSES: readonly number[] = [
  APPOINTMENT_STATUS.PENDING,
  APPOINTMENT_STATUS.CONFIRMED,
];

/**
 * `requestedTime` 必须晚于当前时间（R30）——校验器本身是**共用**的
 * `IsDateBoundary`（见 `common/decorators/is-date-boundary.validator.ts`），
 * 它按被校验字段名生成文案，于是 400 的 `data.fields` 点名的是
 * `requestedTime`（ERR-06）。
 */

/**
 * `POST /appointments` 的请求体（R25，需求 §2.2「预约填报字段」逐条落）。
 *
 * `requestedTime` 只收 **ISO 8601 字符串**（`@IsString` + `@IsISO8601`），
 * **必须晚于当前时间**（R30）。数字时间戳不是契约的一部分，一律 400。
 * `type` / `mode` 用 `@IsInt()` + `@IsIn`：布尔值（`true` → `1`）与小数都在
 * DTO 层拦成 400 / 10001，`data.fields` 点名对应字段。
 */
export class CreateAppointmentDto {
  @ApiProperty({
    description: '被预约的导师档案 ID（MentorProfile.id，BIGINT 对外字符串）',
    example: '1',
  })
  @IsBigIntId({ message: 'mentorProfileId 必须是合法的数字 ID' })
  mentorProfileId!: string;

  @ApiProperty({
    description:
      '预约类型：1 双创竞赛指导 / 2 科研项目指导 / 3 创业实践指导 / ' +
      '4 论文·专利指导 / 5 其他双创指导',
    enum: APPOINTMENT_TYPES,
    example: APPOINTMENT_TYPE.COMPETITION,
  })
  @Transform(toNumberIfNumericString)
  @IsInt({ message: 'type 必须是 1-5 的整数' })
  @IsIn(APPOINTMENT_TYPES, { message: 'type 必须是 1-5 的整数' })
  type!: number;

  @ApiProperty({
    description: '命中导师开放时段（MentorTimeSlot.id，BIGINT 对外字符串）',
    example: '1',
  })
  @IsBigIntId({ message: 'slotId 必须是合法的数字 ID' })
  slotId!: string;

  @ApiProperty({
    description:
      '期望指导时间，**ISO 8601 字符串**（数字时间戳不收）；必须是 UTC 时刻。' +
      '换算成本地时区后必须落在 slotId 对应的开放时段内（默认 `Asia/Shanghai`），' +
      '且必须晚于当前时间（R15 / R30 / R31）',
    example: '2026-11-02T02:00:00.000Z',
  })
  @IsString({ message: 'requestedTime 必须是 ISO 8601 字符串' })
  @IsISO8601(
    { strict: true },
    { message: 'requestedTime 必须是合法的 ISO 8601 时间' },
  )
  @Validate(IsDateBoundary, ['future'])
  requestedTime!: string;

  @ApiProperty({
    description: '指导主题，1-200 字',
    example: '挑战杯项目选题与打磨',
  })
  @IsString({ message: 'topic 必须是字符串' })
  @Length(1, 200, { message: 'topic 长度必须是 1-200 个字符' })
  topic!: string;

  @ApiProperty({
    description: '拟咨询问题，1-2000 字',
    example: '如何把技术方案讲成一个好故事？',
  })
  @IsString({ message: 'questions 必须是字符串' })
  @Length(1, 2000, { message: 'questions 长度必须是 1-2000 个字符' })
  questions!: string;

  @ApiProperty({
    description: '对接方式：1 线上 / 2 线下',
    enum: APPOINTMENT_MODES,
    example: APPOINTMENT_MODE.ONLINE,
  })
  @Transform(toNumberIfNumericString)
  @IsInt({ message: 'mode 只能是 1 或 2' })
  @IsIn(APPOINTMENT_MODES, { message: 'mode 只能是 1 或 2' })
  mode!: number;
}
