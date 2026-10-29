import { Module } from '@nestjs/common';
import { GeneralBackModule } from './general-back.module';
import { MentorApplicationModule } from './modules/mentor-application/mentor-application.module';
import { MentorMaterialModule } from './modules/mentor-material/mentor-material.module';
import { MentorModule } from './modules/mentor/mentor.module';
import { SyncModule } from './modules/sync/sync.module';

/**
 * 根模块。通用后台整套能力由 {@link GeneralBackModule} 挂上，自己只写业务模块。
 *
 * **`forRoot()` 不能省**：它内部的 `ConfigModule.forRoot` 会在被调用的那一刻跑
 * 环境校验。写死在 `@Module` 装饰器上，就变成「只想 import 一个 `BusinessException`」
 * 也得先把 JWT_SECRET 等配齐——业务单测、DTO 单测、工具脚本全都会起不来。
 * `forRoot()` 把求值推到**显式装配**的时候，那才是「应用在启动」。
 *
 * 新写的 Controller **默认带鉴权**（AuthModule 里注册了三个 APP_GUARD）：
 * 不写 `@RequirePermission` 就是 403，忘了挂守卫不会变成一条裸奔接口。
 *
 * 业务模块排在 `GeneralBackModule` **后面**：AuthModule 的三个 APP_GUARD 是按
 * 模块顺序注册的，通用后台的鉴权要先立起来。
 */
@Module({
  imports: [
    GeneralBackModule.forRoot(),
    SyncModule,
    MentorModule,
    MentorApplicationModule,
    MentorMaterialModule,
  ],
})
export class AppModule {}
