import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  Matches,
  Max,
  Min,
  Validate,
  ValidateIf,
  type ValidationArguments,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';

/**
 * 导师可指导时段（Task 21）的请求体。
 *
 * `weekday` 1 周一 … 7 周日；`startTime` / `endTime` 是 `HH:mm` 的**字符串**
 * （库列 `VarChar(5)`，不是时间戳）；`endTime` 必须严格晚于 `startTime`
 * （否则 DTO 层 400 / 10001，`data.fields` 点名 `endTime`）。
 *
 * 半开区间 `[startTime, endTime)`：首尾相接（11:00-12:00 紧邻 09:00-11:00）
 * 不算重叠，重叠判定在 Service 里做（`MENTOR_SLOT_OVERLAP`）。
 */
export const SLOT_WEEKDAY_MIN = 1;
export const SLOT_WEEKDAY_MAX = 7;

/** `HH:mm`，00:00 … 23:59（`25:00` / `9:00` 一律不过） */
export const SLOT_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `MentorTimeSlot.status`：0 关闭 | 1 开放 */
export const SLOT_STATUS = {
  CLOSED: 0,
  OPEN: 1,
} as const;

/**
 * 跨字段校验：`endTime > startTime`（同为合法 `HH:mm` 时按字符串比较即可，
 * 定长格式的字典序就是时间序）。挂在 `endTime` 上，于是 400 的
 * `data.fields` 点名的是 `endTime`（ERR-06）。
 *
 * `startTime` 自身格式非法时返回 true——让 `@Matches` 去报 `startTime`，
 * 不在这里重复报一次 `endTime`。
 */
@ValidatorConstraint({ name: 'isEndAfterStart', async: false })
export class IsEndAfterStart implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const start = (args.object as { startTime?: unknown }).startTime;
    if (typeof value !== 'string' || typeof start !== 'string') {
      return true;
    }
    if (!SLOT_TIME_PATTERN.test(value) || !SLOT_TIME_PATTERN.test(start)) {
      return true;
    }
    return value > start;
  }

  defaultMessage(): string {
    return 'endTime 必须晚于 startTime';
  }
}

export class CreateSlotDto {
  @ApiProperty({
    description: '星期几：1 周一 … 7 周日',
    enum: [1, 2, 3, 4, 5, 6, 7],
    example: 1,
  })
  @Type(() => Number)
  @IsInt({ message: 'weekday 必须是 1-7 的整数' })
  @Min(SLOT_WEEKDAY_MIN, { message: 'weekday 必须是 1-7 的整数' })
  @Max(SLOT_WEEKDAY_MAX, { message: 'weekday 必须是 1-7 的整数' })
  weekday!: number;

  @ApiProperty({
    description: '开始时间，`HH:mm`（00:00 … 23:59）',
    example: '09:00',
  })
  @Matches(SLOT_TIME_PATTERN, { message: 'startTime 必须是 HH:mm 格式' })
  startTime!: string;

  @ApiProperty({
    description: '结束时间，`HH:mm`，**必须严格晚于 startTime**',
    example: '11:00',
  })
  @Matches(SLOT_TIME_PATTERN, { message: 'endTime 必须是 HH:mm 格式' })
  @Validate(IsEndAfterStart)
  endTime!: string;

  @ApiPropertyOptional({
    description:
      '0 关闭 | 1 开放；新建时省略 = 1（开放），更新时省略 = 保留原值。**null 不合法**（400）',
    enum: [SLOT_STATUS.CLOSED, SLOT_STATUS.OPEN],
    example: SLOT_STATUS.OPEN,
  })
  // 不用 `@IsOptional()`：它把 `null` 当「没传」放行，于是 `status: null` 会被
  // 静默改写成默认值（DTO-14 要求显式决定 null 的语义）。这里只有「省略」算没传，
  // `null` 仍然进 `@IsIn` → 400 / 10001，`data.fields` 点名 `status`。
  @ValidateIf((_object, value) => value !== undefined)
  @Type(() => Number)
  @IsIn([SLOT_STATUS.CLOSED, SLOT_STATUS.OPEN], {
    message: 'status 只能是 0 或 1',
  })
  status?: number;
}
