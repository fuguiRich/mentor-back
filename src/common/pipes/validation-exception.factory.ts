import type { ValidationError } from 'class-validator';
import { ValidationException } from '../errors/validation.exception';

function flatten(
  errors: ValidationError[],
  parentPath = '',
): Array<{ field: string; message: string }> {
  return errors.flatMap((error) => {
    const path = parentPath
      ? `${parentPath}.${error.property}`
      : error.property;
    const own = Object.values(error.constraints ?? {}).map((message) => ({
      field: path,
      message,
    }));

    return [...own, ...flatten(error.children ?? [], path)];
  });
}

/** ValidationPipe 的 exceptionFactory：把默认的 message 数组换成逐字段清单 */
export function validationExceptionFactory(
  errors: ValidationError[],
): ValidationException {
  return new ValidationException(flatten(errors));
}
