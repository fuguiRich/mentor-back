import { Module } from '@nestjs/common';
import { AppointmentModule } from '../appointment/appointment.module';
import { UserModule } from '../user/user.module';
import { MentorReviewController } from './mentor-review.controller';
import { ReviewController } from './review.controller';
import { ReviewRepository } from './review.repository';
import { ReviewService } from './review.service';

/**
 * 评价（P3 Task 34）。本模块挂 **3 条路由**：
 * `POST /appointments/:id/review`、`GET /appointments/:id/review`、
 * `GET /mentors/:mentorId/reviews`。
 *
 * 依赖 `AppointmentModule`（复用 `findVisibleEntity` 的可见性断言——评价的
 * 可见性与预约同源，抄一份迟早会分叉）与 `UserModule`（身份链第 1 步）。
 * **不依赖 `DataScopeModule`**：本模块自己不做数据范围收窄，`@DataScope`
 * 天花板由拦截器与 `AppointmentService` 内部解析。
 *
 * 写只有 `student_review` 一张表；`appointment` 上唯一的写是 `4 → 6` 那一跳，
 * 与评价插入同事务（见 `ReviewRepository.createWithTransition`）。
 */
@Module({
  imports: [AppointmentModule, UserModule],
  controllers: [ReviewController, MentorReviewController],
  providers: [ReviewService, ReviewRepository],
})
export class ReviewModule {}
