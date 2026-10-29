import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * 标记「不需要登录」的路由。全局 `JwtAuthGuard` 默认拒绝，只有显式标了它的才放行。
 *
 * 默认拒绝而不是默认放行，是因为漏挂守卫的症状是"多了一条无鉴权的接口"，
 * 而它不报错、不告警、测试也不会红（spec 第 7 节的原话）。
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
