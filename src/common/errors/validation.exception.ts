import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../constants/error-code';
import type { FieldErrorDto } from '../dto/field-error.dto';

/**
 * 参数校验失败。响应体带逐字段的错误清单（规范 ERR-06）——
 * 只说「参数错误」的话，前端只能一轮一轮试出是哪个字段。
 */
export class ValidationException extends BadRequestException {
  constructor(fields: FieldErrorDto[]) {
    super({
      code: ErrorCode.PARAM_INVALID,
      message: '参数校验失败',
      data: { fields },
    });
  }
}
