import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, type ConfigModuleOptions } from '@nestjs/config';
import { configModuleOptions } from './bootstrap';
import { HealthModule } from './infra/health/health.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { RedisModule } from './infra/redis/redis.module';
import { AuthModule } from './modules/auth/auth.module';
import { SysConfigModule } from './modules/config/config.module';
import { DataScopeModule } from './modules/data-scope/data-scope.module';
import { DeptModule } from './modules/dept/dept.module';
import { DictModule } from './modules/dict/dict.module';
import { FileModule } from './modules/file/file.module';
import { OpLogModule } from './modules/oplog/oplog.module';
import { PermissionModule } from './modules/permission/permission.module';
import { RoleModule } from './modules/role/role.module';
import { UserModule } from './modules/user/user.module';

/**
 * 聚合根。使用方一行 `imports: [GeneralBackModule.forRoot()]` 就拿到整套后台面：
 * 36 个路径 / 55 个操作、统一响应外壳、全局鉴权默认拒绝、审计与软删除、
 * Redis 会话、限流、Swagger 文档。自己只写业务模块。
 *
 * 三件事是这里必须一并给出的，少一件「脚手架」就不成立：
 *
 * 1. **ConfigModule.forRoot** —— 环境校验与配置加载是本系统
 *    的地基，各模块的工厂都从 ConfigService 取值。使用方要加自己的配置项就自己
 *    再 `ConfigModule.forRoot` 一次（Nest 会合并），或者复制 `configModuleOptions`
 *    往 `load` 里多塞一个 factory，然后把整份传给 `forRoot()`。
 * 2. **AuthModule 里的三个 APP_GUARD** —— 新写的 Controller **默认带鉴权**，
 *    不写 `@RequirePermission` 就是 403，忘了挂守卫不会变成一条裸奔接口。
 *    这是种子能被复用的最大理由：安全默认值不靠人记。
 * 3. **exports 全开** —— 业务模块要写「按数据范围过滤的列表」就得拿
 *    `DataScopeService`，要种权限点就得拿 `PermissionService`，要发文件就得拿
 *    `FileService`。藏起来等于让使用方自己重写一遍。
 *
 * 模块顺序沿用 AppModule：AuthModule 排在前面，它的三个守卫（JwtAuth →
 * Permission → RateLimit）先于其余模块注册，顺序不能颠倒——PermissionGuard
 * 读的是 JwtAuthGuard 写进请求上下文的身份，反过来它会看到空上下文。
 */
@Module({})
export class GeneralBackModule {
  /**
   * **为什么是 `forRoot()` 而不是把 `ConfigModule.forRoot` 写在 `@Module` 装饰器里**：
   * 装饰器参数在**模块被 require 的那一刻**就求值，而 `ConfigModule.forRoot` 会立刻
   * 跑 `validateEnv`。写死在装饰器上，等于「只想 import 一个 `BusinessException`」
   * 也得先把整套环境变量配齐——业务单测、DTO 单测、工具脚本全都会因为
   * `JWT_SECRET 未配置` 而起不来。`forRoot()` 把求值推到使用方**显式装配**的时候，
   * 那才是「应用在启动」，环境没配齐本来就该报错。
   *
   * 传 `config` 可以完全接管配置装载（换 `envFilePath`、加自己的 factory、
   * 换校验函数）；不传就用本包的默认那份，行为与单独跑本仓库一致。
   */
  static forRoot(
    config: ConfigModuleOptions = configModuleOptions,
  ): DynamicModule {
    return {
      module: GeneralBackModule,
      imports: [
        ConfigModule.forRoot(config),
        PrismaModule,
        RedisModule,
        HealthModule,
        AuthModule, // ← 里面注册了三个 APP_GUARD，全站默认拒绝从这一行开始生效
        DeptModule,
        PermissionModule,
        RoleModule,
        UserModule,
        DataScopeModule,
        DictModule,
        SysConfigModule,
        OpLogModule,
        FileModule,
      ],
      exports: [
        PrismaModule,
        RedisModule,
        AuthModule,
        DeptModule,
        PermissionModule,
        RoleModule,
        UserModule,
        DataScopeModule,
        DictModule,
        SysConfigModule,
        OpLogModule,
        FileModule,
      ],
    };
  }
}
