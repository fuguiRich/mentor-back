import { HttpException, type HttpStatus } from '@nestjs/common';

/**
 * 业务失败的统一异常。携带业务错误码，由全局异常过滤器转成统一外壳。
 *
 * 用显式传入的 HTTP 状态码，而不是从业务码反推——业务码的段位只表达
 * 「属于哪个模块」，不表达「是 404 还是 409」。两者的关系在抛出点最清楚。
 */
export class BusinessException extends HttpException {
  constructor(code: number, message: string, status: HttpStatus) {
    super({ code, message, data: null }, status);
  }
}
