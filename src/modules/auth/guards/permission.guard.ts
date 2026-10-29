import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '../../../common/constants/error-code';
import { PERMISSION_KEY } from '../../../common/decorators/require-permission.decorator';
import {
  currentPermissions,
  currentUser,
} from '../../../common/context/request-context';
import { BusinessException } from '../../../common/errors/business.exception';

/**
 * 只对带 `@RequirePermission` 的路由生效；其余路由只校验登录。
 * 注册顺序必须在 JwtAuthGuard **之后**（它读的身份是前者写进上下文的）。
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    // 空码表（`@RequirePermission()` 零参数）= 只要求登录，这里放行——登录归 JwtAuthGuard。
    if (required === undefined || required.length === 0) {
      return true;
    }

    const user = currentUser();
    if (user === undefined) {
      // 走到这里说明路由同时标了 `@Public()` 与 `@RequirePermission`——配置自相矛盾。
      // 静默放行会让它变成一条无鉴权的接口，所以拒绝。
      throw new BusinessException(
        ErrorCode.UNAUTHORIZED,
        '登录状态已失效，请重新登录',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // 超管跳过全部权限检查（spec 决策 10）
    if (user.isSuperAdmin) {
      return true;
    }

    const owned = new Set(currentPermissions());
    const missing = required.filter((code) => !owned.has(code));
    if (missing.length > 0) {
      throw new BusinessException(
        ErrorCode.FORBIDDEN,
        `无权限访问：缺少 ${missing.join('、')}`,
        HttpStatus.FORBIDDEN,
      );
    }

    return true;
  }
}
