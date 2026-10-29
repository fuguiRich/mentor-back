import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { dataScopeCeilingOf } from '../decorators/data-scope.decorator';
import { requestContext } from '../context/request-context';

/**
 * 把 `@DataScope` 声明的上限写进请求上下文（`currentDataScopeCeiling()` 读它）。
 *
 * **零依赖**——它只做「读装饰器、写上下文」，解析归 `DataScopeService`（R9）。
 * 红线：不许注入 `UserRepository` / `DeptRepository`——「这人部门是哪个」要查库，
 * 而 `DataScopeService` 故意不依赖 `UserModule`（反向依赖会让模块图成环），
 * 所以解析留在 Service，这里只搬上限。ceiling 为 `'self'` 时根本不需部门。
 */
@Injectable()
export class DataScopeInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    // ctx.getHandler() 的声明类型是宽的 Function；装饰器钉的是「真·处理函数」签名
    const ceiling = dataScopeCeilingOf(
      ctx.getHandler() as (...args: unknown[]) => unknown,
      ctx.getClass(),
    );

    // 与 setAuthenticatedUser 同法：中间件已 run() 过，这里取出来就地改。
    // 没有上下文（理论不该发生在 HTTP 链路上）就跳过——currentDataScopeCeiling()
    // 自己会回落 'self'，fail-closed，不必在这里把请求打死。
    const store = requestContext.getStore();
    if (store !== undefined) {
      store.dataScopeCeiling = ceiling;
    }

    return next.handle();
  }
}
