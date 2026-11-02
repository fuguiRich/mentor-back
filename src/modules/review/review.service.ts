import { HttpStatus, Injectable } from '@nestjs/common';
import type { SyncPerson } from '@prisma/client';
import { ErrorCode } from '../../common/constants/error-code';
import type { RequestUser } from '../../common/context/request-context';
import { BusinessException } from '../../common/errors/business.exception';
import { UserService } from '../user/user.service';
import { AppointmentService } from '../appointment/appointment.service';
import { APPOINTMENT_STATUS } from '../appointment/dto/create-appointment.dto';
import type { CreateReviewDto } from './dto/create-review.dto';
import type { QueryReviewDto } from './dto/query-review.dto';
import type {
  ReviewListResponseDto,
  ReviewResponseDto,
} from './dto/review-response.dto';
import { round2, toReviewResponse, toReviewSummary } from './review.mapper';
import { ReviewRepository } from './review.repository';

/** 导师档案必须处于「已生效」才对外可见（与检索、预约同一口径） */
const MENTOR_PROFILE_APPROVED = 2;

/**
 * 学生评价（P3 Task 34 / 需求 §2.5）。
 *
 * 三条不变量：
 * 1. **只有申请人本人能写**。可见 ≠ 可写：管理员看得见这条预约，但评价是学生的
 *    主观判断，管理员代写会把「学生评价」变成「学院评价」。
 * 2. **只在 `4 STUDENT_CONFIRMED` 上写**（R43）。写评价与 `4 → 6` 同一事务，
 *    所以「有评价但没完成」与「完成了但没评价」都不会成为稳定状态。
 * 3. **匿名**（R44）。响应里没有任何学生身份字段，见 {@link ReviewResponseDto}。
 */
@Injectable()
export class ReviewService {
  constructor(
    private readonly repository: ReviewRepository,
    private readonly appointments: AppointmentService,
    private readonly users: UserService,
  ) {}

  /**
   * `POST /appointments/:id/review`。
   *
   * 守卫**先到先拒**：
   *   1. 预约不存在 / 已软删 → **404 / 32001**（复用预约域的可见性断言）
   *   2. 不可见 / 不是申请人本人 → **403 / 32002**
   *   3. 已有未删评价 → **409 / 34002**
   *   4. 预约状态不是 `4` → **409 / 34003**
   *
   * 第 3 条排在第 4 条**前面**：写评价与 `4 → 6` 同事务，评价过的预约状态必然是 `6`，
   * 状态优先的话 34002 永远不可达。并发下两个请求都过第 3 条，输的一方在事务里被
   * `updateMany` 的 `count === 0` 挡下，得到 34003。
   */
  async create(
    appointmentId: bigint,
    dto: CreateReviewDto,
    caller: RequestUser,
  ): Promise<ReviewResponseDto> {
    const appointment = await this.appointments.findVisibleEntity(
      appointmentId,
      caller,
    );

    const person = await this.resolveCallerPerson(caller);
    if (person === null || person.id !== appointment.studentPersonId) {
      throw this.forbidden();
    }

    // 先判「已评价过」再判状态：写评价与 `4 → 6` 同事务，所以一条预约一旦评价过，
    // 状态就已经是 `6`。若按「状态优先」，重复提交会拿到 34003「当前状态不允许评价」，
    // 而 34002「该预约已评价过」永远不可达——两个码只剩一个是真的，另一个是死码。
    // 顺序反过来之后，学生看到的是准确的原因（已评过），并发下的输家仍由事务里的
    // `count === 0` 兜到 34003。
    const existing = await this.repository.findByAppointmentId(appointmentId);
    if (existing !== null) {
      throw this.alreadyExists();
    }

    if (appointment.status !== APPOINTMENT_STATUS.STUDENT_CONFIRMED) {
      throw this.notAllowed();
    }

    const created = await this.repository.createWithTransition(appointmentId, {
      attitude: dto.attitude,
      expertise: dto.expertise,
      effect: dto.effect,
      overallScore: this.overallScore(dto),
      comment: dto.comment ?? null,
    });
    if (created === null) {
      // 条件更新没命中：并发的另一个请求先把预约推进到了 6
      throw this.notAllowed();
    }

    return toReviewResponse(created, appointment.mentorProfileId);
  }

  /**
   * `GET /appointments/:id/review`。
   *
   * 可见性与预约本身同源（{@link AppointmentService.findVisibleEntity}）：
   * 申请人本人 / 该预约的导师本人 / 覆盖申请人部门的管理员。
   * 还没评价 → **404 / 34001**（与「预约不存在」的 32001 分开）。
   */
  async findByAppointment(
    appointmentId: bigint,
    caller: RequestUser,
  ): Promise<ReviewResponseDto> {
    const appointment = await this.appointments.findVisibleEntity(
      appointmentId,
      caller,
    );
    const review = await this.repository.findByAppointmentId(appointmentId);
    if (review === null) {
      throw this.notFound();
    }
    return toReviewResponse(review, appointment.mentorProfileId);
  }

  /**
   * `GET /mentors/:mentorId/reviews`。
   *
   * `:mentorId` 是 `MentorProfile.id`。档案不存在 / 未生效 → **404 / 31102**
   * （与检索页、预约发起同一口径：草稿档案不该有对外可见的评价页）。
   *
   * `summary` 是**全量**口径，不受 `page` / `pageSize` 影响——前端拿它画星，
   * 拿 `list` 翻页；两者混用会让「翻到第 2 页星级变了」。
   */
  async listByMentor(
    mentorProfileId: bigint,
    query: QueryReviewDto,
  ): Promise<ReviewListResponseDto> {
    const profile = await this.repository.findProfileById(mentorProfileId);
    if (profile === null || profile.status !== MENTOR_PROFILE_APPROVED) {
      throw this.mentorNotFound();
    }

    const [rows, total] = await this.repository.findPageByMentorProfile(
      mentorProfileId,
      (query.page - 1) * query.pageSize,
      query.pageSize,
    );
    const aggregate =
      await this.repository.aggregateByMentorProfile(mentorProfileId);

    return {
      list: rows.map((row) => toReviewResponse(row, mentorProfileId)),
      total,
      page: query.page,
      pageSize: query.pageSize,
      summary: toReviewSummary(aggregate),
    };
  }

  /** `round((attitude + expertise + effect) / 3, 2)`，落库前定好（R41） */
  private overallScore(dto: CreateReviewDto): string {
    const average = (dto.attitude + dto.expertise + dto.effect) / 3;
    return round2(average).toFixed(2);
  }

  /** 身份链：`caller.userId` → `SysUser.username` → `SyncPerson.login` */
  private async resolveCallerPerson(
    caller: RequestUser,
  ): Promise<SyncPerson | null> {
    const user = await this.users.findById(caller.userId);
    if (user === null) {
      return null;
    }
    return this.repository.findPersonByLogin(user.username);
  }

  private forbidden(): BusinessException {
    return new BusinessException(
      ErrorCode.APPOINTMENT_FORBIDDEN,
      '无权访问该预约',
      HttpStatus.FORBIDDEN,
    );
  }

  private notFound(): BusinessException {
    return new BusinessException(
      ErrorCode.REVIEW_NOT_FOUND,
      '该预约还没有评价',
      HttpStatus.NOT_FOUND,
    );
  }

  private alreadyExists(): BusinessException {
    return new BusinessException(
      ErrorCode.REVIEW_ALREADY_EXISTS,
      '该预约已评价过',
      HttpStatus.CONFLICT,
    );
  }

  private notAllowed(): BusinessException {
    return new BusinessException(
      ErrorCode.REVIEW_NOT_ALLOWED,
      '当前状态不允许评价',
      HttpStatus.CONFLICT,
    );
  }

  private mentorNotFound(): BusinessException {
    return new BusinessException(
      ErrorCode.MENTOR_PROFILE_NOT_FOUND,
      '导师专业档案不存在',
      HttpStatus.NOT_FOUND,
    );
  }
}
