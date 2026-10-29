import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Observable, map } from 'rxjs';
import { currentTraceId } from '../context/request-context';
import { NO_ENVELOPE_KEY } from '../decorators/no-envelope.decorator';

export interface ResponseEnvelope<T> {
  code: number;
  message: string;
  data: T;
  traceId?: string;
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ResponseEnvelope<T> | T
> {
  constructor(private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ResponseEnvelope<T> | T> {
    const skip = this.reflector.getAllAndOverride<boolean>(NO_ENVELOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) {
      return next.handle();
    }

    return next.handle().pipe(
      map((data) => {
        const traceId = currentTraceId();

        return {
          code: 0,
          message: 'ok',
          data,
          ...(traceId === undefined ? {} : { traceId }),
        };
      }),
    );
  }
}
