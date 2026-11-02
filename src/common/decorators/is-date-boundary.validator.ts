import {
  type ValidationArguments,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';

/**
 * 时间边界的两种方向：
 * - `'future'`：**严格大于**当前时间（发起预约 / 导师改期，R30）；
 * - `'past'`：**小于等于**当前时间（实际指导时间，R35——它允许等于现在，
 *   「已经发生」与「此刻发生」都算已发生）。
 *
 * 两个方向共用一个校验器，是因为它们只差比较方向；拆成两个类会让「边界到底
 * 含不含等号」这件事在两处各写一遍，改一处忘一处就是静默的契约漂移。
 *
 * 挂载时用 `@Validate(IsDateBoundary, ['future'])` / `['past']` 传方向。
 * 错误文案按 `ValidationArguments.property` 点名被校验字段（ERR-06），
 * 所以 `requestedTime` / `proposedTime` / `actualTime` 共用也不会串字段。
 *
 * 非字符串（如数字时间戳）直接放行给 `@IsString` / `@IsISO8601` 报错：本类只
 * 负责「在不在正确的一侧」这一件事，不重复承担格式校验。
 */
export type DateBoundary = 'future' | 'past';

@ValidatorConstraint({ name: 'isDateBoundary', async: false })
export class IsDateBoundary implements ValidatorConstraintInterface {
  validate(value: unknown, args?: ValidationArguments): boolean {
    if (typeof value !== 'string') {
      return true;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return false;
    }
    return boundaryOf(args) === 'future'
      ? parsed.getTime() > Date.now()
      : parsed.getTime() <= Date.now();
  }

  defaultMessage(args: ValidationArguments): string {
    return boundaryOf(args) === 'future'
      ? `${args.property} 必须晚于当前时间`
      : `${args.property} 不得晚于当前时间`;
  }
}

/** 取方向；没传时按 `'future'`（既有调用点都是未来时间），保持向后兼容 */
function boundaryOf(args: ValidationArguments | undefined): DateBoundary {
  // `constraints` 的类型是 `any[]`，先收窄成 `unknown[]` 再取值，避免 any 外溢
  const boundary = (args?.constraints as unknown[] | undefined)?.[0];
  return boundary === 'past' ? 'past' : 'future';
}
