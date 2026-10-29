import { SetMetadata } from '@nestjs/common';

export const PERMISSION_KEY = 'requiredPermissions';

/**
 * 声明访问该路由所需的权限码（多个为「与」关系）。
 * 权限码格式 `<资源>:<动作>`、资源名单数（spec 决策 9）。
 * 不带此装饰器的路由只校验登录，不校验权限。
 */
export const RequirePermission = (...codes: string[]): MethodDecorator =>
  SetMetadata(PERMISSION_KEY, codes);
