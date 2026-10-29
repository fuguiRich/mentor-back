import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  PayloadTooLargeException,
  HttpStatus,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { ErrorCode } from '../../common/constants/error-code';
import { BusinessException } from '../../common/errors/business.exception';

/**
 * 把 multer 的限额异常翻译成本模块的业务码。
 *
 * 背景：`@nestjs/platform-express` 的 `transformException` 在异常到达我们这里之前，
 * 就把 `MulterError.code`（LIMIT_FILE_SIZE / LIMIT_FILE_COUNT / …）抹成了
 * `PayloadTooLargeException` / `BadRequestException`，码信息就此丢失。
 * 全局异常过滤器只能看到一个 413 或 400，落下来是 10000 / 10001——
 * 客户端分不清「文件太大」和「服务器坏了」。
 *
 * **必须放在 FileInterceptor 外层**：multer 的错误是从它自己的 `intercept()`
 * 抛出来的，不是 `next.handle()` 里的流错误。内层拦截器的 `catchError` 看不见它
 * （见 @nestjs/core 的 interceptors-consumer.js：`interceptors[0]` 是最外层）。
 *
 * 无法再细分 400 的来源：`LIMIT_UNEXPECTED_FILE`（字段名不对 / 多传了一个）、
 * `LIMIT_FILE_COUNT`（超上限）与 multipart 报文畸形，到这里都只剩同一个
 * BadRequestException。按上传场景给一个能用的码，比给 10001 强。
 */
@Injectable()
export class UploadErrorInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(catchError((error: unknown) => translate(error)));
  }
}

function translate(error: unknown): never {
  if (error instanceof BusinessException) {
    throw error;
  }
  if (error instanceof PayloadTooLargeException) {
    throw new BusinessException(
      ErrorCode.FILE_TOO_LARGE,
      '文件超过大小上限',
      HttpStatus.PAYLOAD_TOO_LARGE,
    );
  }
  if (error instanceof BadRequestException) {
    throw new BusinessException(
      ErrorCode.FILE_COUNT_EXCEEDED,
      '上传的文件数量超过上限，或表单字段不合法',
      HttpStatus.BAD_REQUEST,
    );
  }
  throw error;
}
