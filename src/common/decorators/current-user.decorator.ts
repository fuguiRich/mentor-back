import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../constants/error-code';
import { BusinessException } from '../errors/business.exception';
import { currentUser, type RequestUser } from '../context/request-context';

/**
 * 注入当前登录者。
 *
 * 读的是 AsyncLocalStorage 里的请求上下文（守卫写入），不是 `request.user`——
 * 全系统只有一个"当前操作者"的来源，审计字段（Prisma 扩展读同一个 store）
 * 与业务代码才不会各拿各的。
 *
 * 在 `@Public()` 路由上用它 = 配置错误；这里**大声抛 401**，不做静默兜底
 * （返回一个 userId 为 0 的假用户会让下游把操作记成"系统"）。
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, _context: ExecutionContext): RequestUser => {
    const user = currentUser();
    if (user === undefined) {
      throw new BusinessException(
        ErrorCode.UNAUTHORIZED,
        '登录状态已失效，请重新登录',
        HttpStatus.UNAUTHORIZED,
      );
    }

    return user;
  },
);
