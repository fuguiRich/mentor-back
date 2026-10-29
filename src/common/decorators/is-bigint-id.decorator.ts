import { registerDecorator, type ValidationOptions } from 'class-validator';

/**
 * MySQL 列是 BIGINT UNSIGNED（上界 2^64-1），但 Prisma 的驱动按**有符号** 64 位
 * 绑定参数，超过 2^63-1 会在查询时报错——表现为 500 而不是 4xx。
 * 因此这里按 2^63-1 收口：本系统生成的主键远小于它。
 *
 * 同时必须挡住小数：`@IsNumberString()` 默认放行 `1.5` / `-1` / `+1`，
 * 而 `BigInt('1.5')` 会抛 `SyntaxError`，绕过 BusinessException 变成 500。
 */
const MAX_BIGINT_ID = 9223372036854775807n;

function isValidId(value: unknown): boolean {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    return false;
  }

  return BigInt(value) <= MAX_BIGINT_ID;
}

export function IsBigIntId(options?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'isBigIntId',
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      validator: {
        validate(value: unknown): boolean {
          // 同时接受单个 ID 与 ID 数组：`{ each: true }` 在某些 class-validator
          // 版本里不会替自定义装饰器拆数组，写了数组分支后两种行为都正确
          // （executor 拆了 → 每项走 isValidId；没拆 → 整个数组走 every）。
          if (Array.isArray(value)) {
            return value.every(isValidId);
          }

          return isValidId(value);
        },
        defaultMessage(): string {
          return '$property 必须是合法的数字 ID';
        },
      },
    });
  };
}
