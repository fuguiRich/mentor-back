import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { ErrorCode } from '../constants/error-code';
import { currentTraceId } from '../context/request-context';

interface ErrorEnvelope {
  code: number;
  message: string;
  data: unknown;
  traceId?: string;
}

interface HttpExceptionBody {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}

const HTTP_STATUS_TO_ERROR_CODE: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
  [HttpStatus.BAD_REQUEST]: ErrorCode.PARAM_INVALID,
  // 普通 409 也应落到 10006：否则 CONFLICT 只有 Prisma P2002/P2003 一条来路，
  // 枚举与 HTTP 默认表各说各话。
  [HttpStatus.CONFLICT]: ErrorCode.CONFLICT,
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const envelope = this.toEnvelope(exception);
    const traceId = currentTraceId();

    response.status(this.toStatus(exception)).json({
      ...envelope,
      ...(traceId === undefined ? {} : { traceId }),
    });
  }

  private toStatus(exception: unknown): number {
    if (exception instanceof HttpException) {
      return exception.getStatus();
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return HttpStatus.CONFLICT;
        case 'P2025':
          return HttpStatus.NOT_FOUND;
        case 'P2003':
          return HttpStatus.CONFLICT;
        default:
          return HttpStatus.INTERNAL_SERVER_ERROR;
      }
    }
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private toEnvelope(exception: unknown): ErrorEnvelope {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === 'object' && body !== null) {
        const typed = body as HttpExceptionBody;
        return {
          code:
            typeof typed.code === 'number'
              ? typed.code
              : this.defaultCode(status),
          message: this.extractMessage(typed.message, exception.message),
          data: typed.data ?? null,
        };
      }

      return {
        code: this.defaultCode(status),
        message: String(body),
        data: null,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromPrisma(exception);
    }

    // 未预期异常：日志留全量堆栈，响应只给通用文案（规范 ERR-05）。
    // 把 message/stack 返回给客户端等于免费交出表名、目录结构与行号。
    const error =
      exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error(`未捕获异常：${error.message}`, error.stack);

    return {
      code: ErrorCode.INTERNAL_ERROR,
      message: '服务器内部错误',
      data: null,
    };
  }

  private fromPrisma(
    exception: Prisma.PrismaClientKnownRequestError,
  ): ErrorEnvelope {
    // 这三条是兜底。正常路径下 Service 会先做业务校验并抛出具体错误码
    // （如 24102 部门名称已存在），只有并发竞争才会真撞到数据库约束。
    switch (exception.code) {
      case 'P2002':
        this.logger.warn(`唯一约束冲突：${exception.message}`);
        return {
          code: ErrorCode.CONFLICT,
          message: '数据冲突，请刷新后重试',
          data: null,
        };
      case 'P2025':
        return {
          code: ErrorCode.NOT_FOUND,
          message: '资源不存在',
          data: null,
        };
      case 'P2003':
        this.logger.warn(`外键约束失败：${exception.message}`);
        return {
          code: ErrorCode.CONFLICT,
          message: '数据冲突，请刷新后重试',
          data: null,
        };
      default:
        this.logger.error(
          `Prisma 错误 ${exception.code}：${exception.message}`,
        );
        return {
          code: ErrorCode.INTERNAL_ERROR,
          message: '服务器内部错误',
          data: null,
        };
    }
  }

  private defaultCode(status: number): number {
    return HTTP_STATUS_TO_ERROR_CODE[status] ?? ErrorCode.INTERNAL_ERROR;
  }

  private extractMessage(message: unknown, fallback: string): string {
    if (typeof message === 'string') {
      return message;
    }
    if (Array.isArray(message)) {
      return message.join('；');
    }
    return fallback;
  }
}
