import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { PermissionModule } from '../permission/permission.module';
import { RateLimitModule } from '../../infra/rate-limit/rate-limit.module';
import { RateLimitGuard } from '../../infra/rate-limit/rate-limit.guard';
import { UserModule } from '../user/user.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PermissionCacheService } from './permission-cache.service';
import { TokenService } from './token.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionGuard } from './guards/permission.guard';
import type { AppConfig } from '../../config/configuration';
import { MockSsoProvider } from './sso/mock-sso.provider';
import { OidcSsoProvider } from './sso/oidc-sso.provider';
import { SSO_PROVIDER, type SsoProvider } from './sso/sso.provider';

/**
 * 全局默认拒绝的**唯一**注册点（spec 第 7 节「守卫全局注册，用 @Public() 显式开口子」）。
 *
 * 两个守卫都用 APP_GUARD 多重 provider：Nest 会把它们套在**所有**路由外层，
 * 包括将来新加的模块——新加一个 Controller 而忘记挂守卫，不会变成一条无鉴权接口。
 * 顺序不能反：PermissionGuard 读的身份是 JwtAuthGuard 写进请求上下文的，
 * 反过来它会看到空上下文，把所有带 @RequirePermission 的路由一律 401。
 *
 * 之所以注册在这里而不是 AppModule：这两个守卫要注入 TokenService /
 * PermissionCacheService，都是本模块的 provider。放 AppModule 就得把它们全部
 * 导出并把 AuthModule 做成 @Global()——为一个注册点把整个模块变成全局可见，
 * 比在自己的模块里注册贵得多。
 */
@Module({
  imports: [
    UserModule,
    PermissionModule,
    RateLimitModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('jwt.secret'),
        signOptions: {
          // HS256 写死，不从环境读：算法是可以被降级攻击的参数
          // （把 HS256 换成 none 或换一种算法是 JWT 的经典攻击面）。
          algorithm: 'HS256',
        },
      }),
    }),
  ],
  providers: [
    AuthService,
    TokenService,
    PermissionCacheService,
    {
      provide: SSO_PROVIDER,
      useFactory: (config: ConfigService<AppConfig, true>): SsoProvider => {
        const kind = config.get('sso.provider', { infer: true });
        return kind === 'oidc'
          ? new OidcSsoProvider(config)
          : new MockSsoProvider(config);
      },
      inject: [ConfigService],
    },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    // 限流必须排在鉴权之后：额度按「人」算才准，而身份是 JwtAuthGuard 写进
    // 请求上下文的。排到前面就退化成按 IP 限流，高校 NAT 会让真实用户互相打死。
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
  controllers: [AuthController],
  exports: [AuthService, TokenService, PermissionCacheService],
})
export class AuthModule {}
