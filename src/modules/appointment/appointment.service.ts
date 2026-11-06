import { HttpStatus, Injectable, type StreamableFile } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type {
  Appointment,
  AppointmentMaterial,
  GuidanceMaterial,
  MentorProfile,
  MentorTimeSlot,
  SyncPerson,
} from '@prisma/client';
import { ErrorCode } from '../../common/constants/error-code';
import { isDeptInFilter } from '../../common/constants/data-scope';
import {
  currentDataScopeCeiling,
  type RequestUser,
} from '../../common/context/request-context';
import { BusinessException } from '../../common/errors/business.exception';
import type { AppConfig } from '../../config/configuration';
import { DataScopeService } from '../data-scope/data-scope.service';
import { ConfigService as SysConfigService } from '../config/config.service';
import { FileService } from '../file/file.service';
import { UserService } from '../user/user.service';
import type { MentorRecordListResponseDto } from './dto/mentor-record-response.dto';
import type { QueryMentorRecordDto } from './dto/query-mentor-record.dto';
import {
  toAppointmentDetail,
  toAppointmentListItem,
  toAppointmentResponse,
} from './appointment.mapper';
import { toGuidanceRecordResponse } from './guidance-record.mapper';
import { csvFilename } from '../stats/export/csv.writer';
import {
  toAppointmentMaterialResponse,
  toGuidanceMaterialResponse,
} from './appointment-material.mapper';
import {
  AppointmentRepository,
  SLOT_OPEN_STATUS,
  type AppointmentListFilter,
  type AppointmentWithStudent,
  type GuidanceRecordWithStudent,
} from './appointment.repository';
import {
  APPOINTMENT_STATUS,
  CANCELLABLE_APPOINTMENT_STATUSES,
  type CreateAppointmentDto,
} from './dto/create-appointment.dto';
import type { ConfirmAppointmentDto } from './dto/confirm-appointment.dto';
import type { AdjudicateAppointmentDto } from './dto/adjudicate-appointment.dto';
import { ADJUDICATE_DECISION } from './dto/adjudicate-appointment.dto';
import type { DisputeAppointmentDto } from './dto/dispute-appointment.dto';
import type { RejectAppointmentDto } from './dto/reject-appointment.dto';
import type { RescheduleAppointmentDto } from './dto/reschedule-appointment.dto';
import type { AppointmentResponseDto } from './dto/appointment-response.dto';
import type {
  AppointmentDetailDto,
  AppointmentListResponseDto,
  QueryAppointmentDto,
} from './dto/appointment-list.dto';
import type { SubmitGuidanceRecordDto } from './dto/submit-guidance-record.dto';
import type { GuidanceRecordResponseDto } from './dto/guidance-record-response.dto';
import {
  MATERIAL_SOURCE,
  type AppointmentMaterialListResponseDto,
  type AppointmentMaterialResponseDto,
  type AttachAppointmentMaterialDto,
  type AttachRecordMaterialDto,
  type DeleteAppointmentMaterialResponseDto,
} from './dto/appointment-material.dto';

/**
 * 发起预约（Task 23，学生侧）。这是**预约状态机的入口**：落一条
 * `status = 0 PENDING` 的预约，后续 Task 24-28 都在它之上推进。
 *
 * 守卫**先到先拒**，顺序即错误码顺序：
 *   1. 调用者不是学生（无 `SyncPerson` / `personType != 'student'`）→ 403 / 10003
 *   2. 导师档案不存在 / 未生效 / 已软删 / 人员已软删 → 404 / 31102
 *   3. `slotId` 不存在 / 已软删 / 不属于该导师 / `status = 0` → 409 / 31202
 *   4. `requestedTime` 与时段不匹配（weekday 或 `[startTime, endTime)`）→ 409 / 31202
 *   5. 同一时段已有未终态预约 → 409 / 32004
 *   6. 同一学生对同一导师已有未终态预约 → 409 / 32003
 *
 * 第 5、6 条在 `createWithSlotLock` 的事务里、行锁之后做（并发安全）。
 *
 * **时段口径（R31）**：`MentorTimeSlot` 的 `weekday` / `HH:mm` 是**每周重复的
 * 墙钟时间**，本身不带时区；`Appointment.requestedTime` 是 UTC 时刻。比对前
 * 把 `requestedTime` 转成业务时区（`app.timezone`，默认 `Asia/Shanghai`，
 * `APP_TIMEZONE` 可覆盖）再取 weekday / 时刻。按 UTC 比会把「周一 09:00-11:00」
 * 当成北京时间 17:00-19:00，学生约到的「上午」成了傍晚。
 */
@Injectable()
export class AppointmentService {
  /**
   * 墙钟时间的格式化器。时区是进程级配置，构造一次复用——每个请求新建一个
   * `Intl.DateTimeFormat` 是白付的分配开销。
   */
  private readonly wallClock: Intl.DateTimeFormat;

  constructor(
    private readonly repository: AppointmentRepository,
    private readonly users: UserService,
    private readonly dataScope: DataScopeService,
    private readonly sysConfig: SysConfigService,
    private readonly fileService: FileService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.wallClock = new Intl.DateTimeFormat('en-US', {
      timeZone: config.getOrThrow('app.timezone', { infer: true }),
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      // `hourCycle: 'h23'` 而不是 `hour12: false`：后者在 en-US 下可能落到
      // h24，午夜会格式化成 `24:00`，半开区间的下界就永远命不中 00:00。
      hourCycle: 'h23',
    });
  }

  async create(
    dto: CreateAppointmentDto,
    caller: RequestUser,
  ): Promise<AppointmentResponseDto> {
    // 守卫 1：调用者必须是学生
    const student = await this.resolveStudent(caller);

    // 守卫 2：导师档案已生效、未软删、人员未离场
    const mentorProfileId = BigInt(dto.mentorProfileId);
    const profile =
      await this.repository.findApprovedMentorById(mentorProfileId);
    if (profile === null) {
      throw this.profileNotFound();
    }

    // 守卫 3：时段属于该导师、未软删、处于开放状态
    const slotId = BigInt(dto.slotId);
    const slot = await this.repository.findOwnedSlotById(slotId, profile.id);
    if (slot === null || slot.status !== SLOT_OPEN_STATUS) {
      throw this.slotUnavailable();
    }

    // 守卫 4：requestedTime 落在该时段的 weekday 与区间内
    // DTO 只收 ISO 8601 字符串（数字时间戳已挡在 400），这里转成瞬时值
    const requestedTime = new Date(dto.requestedTime);
    if (!matchesSlot(requestedTime, slot, this.wallClock)) {
      throw this.slotUnavailable();
    }

    // 守卫 5 / 6：行锁后做一致性 count，再落库
    const result = await this.repository.createWithSlotLock({
      studentPersonId: student.id,
      mentorProfileId: profile.id,
      type: dto.type,
      requestedTime,
      topic: dto.topic,
      questions: dto.questions,
      mode: dto.mode,
      slotId,
    });
    if (result.kind === 'slot-conflict') {
      throw this.slotConflict();
    }
    if (result.kind === 'student-conflict') {
      throw this.duplicateAppointment();
    }
    return toAppointmentResponse(result.appointment);
  }

  /**
   * `POST /appointments/:id/confirm`（Task 24）——`0 PENDING → 1 CONFIRMED`。
   * `handleComment = comment ?? null`：不传意见时显式落 null。
   *
   * 落库走**条件更新**（`updateIfPending`）：守卫 3 的读与写之间有窗口，两个
   * 并发 `confirm` 都可能在读时看到 `status=0`。写时再判一次 `status=0`，
   * 只有一方能赢，输的一方拿 409 / 32003——契约上第二个必须是 409。
   */
  async confirm(
    id: bigint,
    dto: ConfirmAppointmentDto,
    caller: RequestUser,
  ): Promise<AppointmentResponseDto> {
    await this.authorizeHandle(id, caller);
    const updated = await this.repository.updateIfPending(id, {
      status: APPOINTMENT_STATUS.CONFIRMED,
      handleComment: dto.comment ?? null,
    });
    if (updated === null) {
      throw this.transitionInvalid();
    }
    return toAppointmentResponse(updated);
  }

  /**
   * `POST /appointments/:id/reject`（Task 24）——`0 PENDING → 7 REJECTED`。
   * `rejectReason = reason`（`reason` 必填由 DTO 保证）。
   *
   * 同 `confirm`：条件更新兜住并发双发。
   */
  async reject(
    id: bigint,
    dto: RejectAppointmentDto,
    caller: RequestUser,
  ): Promise<AppointmentResponseDto> {
    await this.authorizeHandle(id, caller);
    const updated = await this.repository.updateIfPending(id, {
      status: APPOINTMENT_STATUS.REJECTED,
      rejectReason: dto.reason,
    });
    if (updated === null) {
      throw this.transitionInvalid();
    }
    return toAppointmentResponse(updated);
  }

  /**
   * `POST /appointments/:id/reschedule`（Task 24）——**留在 `0 PENDING`**。
   *
   * R13：只更新 `proposedTime` 与 `handleComment`，**`requestedTime` 一个字不动**
   * ——保留原值才能看出导师改了什么。
   * R33：**不校验 `proposedTime` 是否落在导师开放时段内**，只由 DTO 校验
   * 「必须是未来时间」——导师临时安排不该被自己的周表卡住。
   *
   * 条件更新同样是 `status = 0 PENDING`：确认 / 拒绝之后不能再改期。
   */
  async reschedule(
    id: bigint,
    dto: RescheduleAppointmentDto,
    caller: RequestUser,
  ): Promise<AppointmentResponseDto> {
    await this.authorizeHandle(id, caller);
    const updated = await this.repository.updateIfPending(id, {
      proposedTime: new Date(dto.proposedTime),
      handleComment: dto.comment ?? null,
    });
    if (updated === null) {
      throw this.transitionInvalid();
    }
    return toAppointmentResponse(updated);
  }

  /**
   * `POST /appointments/:id/cancel`（Task 25 / R18）——学生取消自己的预约：
   * 出发态 `0 PENDING` / `1 CONFIRMED` → `8 CANCELLED`，其余状态 409 / 32003。
   *
   * 守卫**先到先拒**（404 → 403 → 409），见 {@link authorizeCancel}。
   * 落库走条件更新 `updateIfCancellable`：预检与写之间若有并发（导师同时确认 /
   * 学生双发取消），只有一方命中出发态集合，输家拿 409 / 32003。
   */
  async cancel(
    id: bigint,
    caller: RequestUser,
  ): Promise<AppointmentResponseDto> {
    await this.authorizeCancel(id, caller);
    const updated = await this.repository.updateIfCancellable(id);
    if (updated === null) {
      throw this.transitionInvalid();
    }
    return toAppointmentResponse(updated);
  }

  /**
   * `POST /appointments/:id/confirm-record`（Task 27 / §2.4）——学生确认指导记录：
   * **`3 RECORD_SUBMITTED → 4 STUDENT_CONFIRMED`**。**不直接到 `6 COMPLETED`**：
   * P3 的学生评价接在 `4` 之后，确认与完成是两步。
   *
   * 守卫**先到先拒**（404 → 403 → 409），见 {@link authorizeRecordConfirmation}。
   * 落库走条件更新 `updateIfRecordSubmitted`：并发双发时只有一方命中 `status = 3`，
   * 输家拿 409 / 32003。
   *
   * **R36**：`disputeReason` 的语义是「当前未决的异议」，不是历史。学生确认即表示
   * 异议已自行解决，这里必须把它清成 `null`——否则「异议 → 管理员退回 `5 → 3` →
   * 学生再次确认 `3 → 4`」之后会留下 `status = 4` 且 `disputeReason` 非 null 的脏态。
   * （管理员退回 `5 → 3` 时**保留**异议内容，Task 28 处理。）
   */
  async confirmRecord(
    id: bigint,
    caller: RequestUser,
  ): Promise<AppointmentResponseDto> {
    await this.authorizeRecordConfirmation(id, caller);
    const updated = await this.repository.updateIfRecordSubmitted(id, {
      status: APPOINTMENT_STATUS.STUDENT_CONFIRMED,
      // R36：确认即视为异议已解决，清空未决异议原因
      disputeReason: null,
    });
    if (updated === null) {
      throw this.transitionInvalid();
    }
    return toAppointmentResponse(updated);
  }

  /**
   * `POST /appointments/:id/dispute`（Task 27 / §2.4）——学生对指导记录提异议：
   * **`3 RECORD_SUBMITTED → 5 DISPUTED`**，`disputeReason = reason`（必填由 DTO 保证）。
   *
   * 异议原因落 `Appointment.disputeReason`——**不复用** `rejectReason`（导师拒绝
   * 预约）与 `handleComment`（导师处理意见），三者语义不同。
   * 守卫与并发口径同 {@link confirmRecord}。
   */
  async dispute(
    id: bigint,
    dto: DisputeAppointmentDto,
    caller: RequestUser,
  ): Promise<AppointmentResponseDto> {
    await this.authorizeRecordConfirmation(id, caller);
    const updated = await this.repository.updateIfRecordSubmitted(id, {
      status: APPOINTMENT_STATUS.DISPUTED,
      disputeReason: dto.reason,
    });
    if (updated === null) {
      throw this.transitionInvalid();
    }
    return toAppointmentResponse(updated);
  }

  /**
   * `POST /appointments/:id/adjudicate`（Task 28 / 需求 §4.3）——二级学院管理员
   * 复核学生异议：
   * - `uphold`：**`5 DISPUTED → 6 COMPLETED`**（支持学生，异议成立，直接完成）；
   * - `return`：**`5 DISPUTED → 3 RECORD_SUBMITTED`**（退回导师重填）。
   *
   * 守卫**先到先拒**（404 → 403 → 409），见 {@link authorizeAdjudicate}。
   * 落库走条件更新 `updateIfDisputed`：并发双发时只有一方命中 `status = 5`，
   * 输家拿 409 / 32003。
   *
   * **R36 / 异议原因的去留**：
   * - `return`（`5 → 3`）**保留** `disputeReason`——导师重填时要能看见学生为什么
   *   提异议，Repository 的 `data` 里因此**不出现**该列；
   * - `uphold`（`5 → 6`）**清空** `disputeReason`——`disputeReason` 的语义是
   *   「当前未决的异议」，终态完成即异议已裁决，留着就是 `status = 6` 且异议非
   *   null 的脏态（与 R36「`3 → 4` 清空」同一条道理）。
   *
   * 复核意见落 `Appointment.adjudicateComment`——**不复用** `handleComment`
   * （导师处理意见）/ `rejectReason`（导师拒绝预约）/ `disputeReason`（学生异议）。
   */
  async adjudicate(
    id: bigint,
    dto: AdjudicateAppointmentDto,
    caller: RequestUser,
  ): Promise<AppointmentResponseDto> {
    await this.authorizeAdjudicate(id, caller);
    const uphold = dto.decision === ADJUDICATE_DECISION.UPHOLD;
    const updated = await this.repository.updateIfDisputed(id, {
      status: uphold
        ? APPOINTMENT_STATUS.COMPLETED
        : APPOINTMENT_STATUS.RECORD_SUBMITTED,
      adjudicateComment: dto.comment,
      // 只有 uphold 显式清空；return 不传 → 保留原异议内容（R36）
      ...(uphold ? { disputeReason: null } : {}),
    });
    if (updated === null) {
      throw this.transitionInvalid();
    }
    return toAppointmentResponse(updated);
  }

  /**
   * `POST /appointments/:id/record`（Task 26 / R19 / R26，Task 28 / R37 扩展）
   * ——导师填报指导记录：
   * **`1 CONFIRMED → 3 RECORD_SUBMITTED` 一步**（跳过 `2 IN_PROGRESS` 的可观测性，
   * `2` 只作为语义态保留）。
   *
   * **R37 重填**：出发态也可以是 `3 RECORD_SUBMITTED`——此时**更新**该预约已有的
   * 那一条记录、状态保持 `3`（见 {@link AppointmentRepository.updateRecordWithTransition}）。
   * 没有这条，`5 → 3` 的「退回重填」是一句空话：记录有唯一键、没有编辑接口。
   *
   * 守卫**先到先拒**（404 → 403 → 409），见 {@link authorizeRecordSubmit}。
   * 落库走 {@link AppointmentRepository.createRecordWithTransition}：条件更新与
   * 建记录在同一事务里；`count = 0` 映射成 409 / 32003。
   * 生成列唯一键**不做兜底捕获**——它只在「记录已存在但预约被拨回 1」的人为不一致下触发；
   * 真撞了按 500 暴露，不伪装成 409（`meta.target` 对生成列不可靠，收窄不了）。
   *
   * `submittedBy` = **该预约导师本人**的 `SyncPerson.id`（来自
   * `MentorProfile.personId`），不是「谁敲的键盘」的 `userId`；`submittedAt` =
   * 服务端当前时间，请求体改不到。
   */
  async submitRecord(
    id: bigint,
    dto: SubmitGuidanceRecordDto,
    caller: RequestUser,
  ): Promise<GuidanceRecordResponseDto> {
    const { submitterPersonId, fromStatus } = await this.authorizeRecordSubmit(
      id,
      caller,
    );
    const input = {
      appointmentId: id,
      actualTime: new Date(dto.actualTime),
      mode: dto.mode,
      coreContent: dto.coreContent,
      followUp: dto.followUp,
      // P3 Task 35 / R58：不传落 0（语义是「未填」，不是「零分钟」）
      durationMinutes: dto.durationMinutes ?? 0,
      submittedBy: submitterPersonId,
      submittedAt: new Date(),
    };
    // 路径由**守卫读到的出发态**决定，而不是在事务里试两次：
    // 1 CONFIRMED → 建记录 + 1→3（原行为）；3 RECORD_SUBMITTED → 更新记录、保持 3（R37）。
    // 若在这里「先试建、没命中再改」，并发里输掉 1→3 的请求会顺势变成一次重填、
    // 返回 200——原契约「并发双发恰一次 201 + 一次 409」就被悄悄改掉了。
    const result =
      fromStatus === APPOINTMENT_STATUS.CONFIRMED
        ? await this.repository.createRecordWithTransition(input)
        : await this.repository.updateRecordWithTransition(input);
    if (result.kind === 'transition-invalid') {
      // 条件更新没命中（预约已不在出发态）→ 409 / 32003。
      // 唯一键冲突**不在这里兜**（返工轮 1 / P2-7）：真撞上按 500 冒出来。
      throw this.transitionInvalid();
    }
    return toGuidanceRecordResponse(result.record);
  }

  /**
   * `GET /appointments/:id/record`（Task 26）——读取一条指导记录。
   *
   * 守卫顺序：记录不存在 / 已软删 → **404 / 33001**；可见性不过 → **403 /
   * 32002**（不是 404——「存在但你看不了」要和「还没填报」分开）。
   *
   * 可见性三选一（{@link assertRecordVisible}）：申请人本人 / 该预约的导师本人 /
   * 数据范围覆盖**申请人部门**的管理员。
   */
  async getRecord(
    id: bigint,
    caller: RequestUser,
  ): Promise<GuidanceRecordResponseDto> {
    const record = await this.repository.findRecordByAppointmentId(id);
    if (record === null) {
      throw this.recordNotFound();
    }
    await this.assertRecordVisible(record, caller);
    return toGuidanceRecordResponse(record);
  }

  /**
   * `GET /appointments`（Task 30）——**一个接口三种视角**，按调用者的
   * **有效数据范围**选一种，**不取并集**：
   *
   * | 有效范围 | 视角 | where |
   * | --- | --- | --- |
   * | `all` | 管理员 | 不加行级约束 |
   * | `dept` / `deptAndChildren` | 管理员 | 申请人组织投影的部门在集合内（R14：按**申请人**部门） |
   * | `self` 且有导师档案 | 导师 | `mentorProfileId ∈ 我名下的档案` |
   * | `self` 且无导师档案 | 学生 | `studentPersonId = 本人 personId` |
   *
   * **为什么 `self` 要再看档案**：学生与导师的 `data_scope` 都是 `self`，光看范围
   * 分不出这两个视角；「能当导师的账号一定名下有档案」（P1 的身份链），
   * 所以有档案走导师、没有走学生。解析不出人（同步未及）→ 空集，不是全部。
   *
   * 取并集（学生视角 ∪ 导师视角）会让「既是导师又有学生预约」的账号拼出一份
   * 谁都没预期过的列表，所以宁可漏也不合。
   *
   * 天花板 `@DataScope('all')`：不夹窄——`dept` 当天花板会把双创学院管理员
   * （`all`）压到 `dept`。收窄由这里按有效范围做。
   */
  async findPage(
    query: QueryAppointmentDto,
    caller: RequestUser,
  ): Promise<AppointmentListResponseDto> {
    const filter = await this.resolveListFilter(caller);
    const from = query.from === undefined ? undefined : new Date(query.from);
    const to =
      query.to === undefined ? undefined : this.upperBoundary(query.to);
    if (
      from !== undefined &&
      to !== undefined &&
      from.getTime() > to.getTime()
    ) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        'from 必须不晚于 to',
        HttpStatus.BAD_REQUEST,
      );
    }
    const { rows, total } = await this.repository.findPage({
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      filter,
      page: query.page,
      pageSize: query.pageSize,
    });

    return {
      list: rows.map(toAppointmentListItem),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * 列表时间上界：纯日期 `YYYY-MM-DD` 表示「当天结束」。
   * `new Date('2026-12-31')` 是 UTC 零点，直接当上界会把当天整天漏掉。
   */
  private upperBoundary(value: string): Date {
    const parsed = new Date(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      parsed.setUTCHours(23, 59, 59, 999);
    }
    return parsed;
  }

  /**
   * `GET /appointments/:id`（Task 30）——单条详情，含更全的学生信息。
   *
   * 守卫**先到先拒**：
   *   1. 预约不存在 / 已软删 → **404 / 32001**
   *   2. 不可见 → **403 / 32002**（**不是 404**——与 `GET /:id/record` 一致）
   *
   * 可见性三选一（{@link assertAppointmentVisible}，与记录 / 材料读取同源）：
   * 申请人本人 / 该预约的导师本人 / 有效数据范围覆盖**申请人部门**的管理员。
   */
  async findOne(
    id: bigint,
    caller: RequestUser,
  ): Promise<AppointmentDetailDto> {
    const appointment = await this.repository.findDetailById(id);
    if (appointment === null) {
      throw this.appointmentNotFound();
    }
    await this.assertAppointmentVisible(appointment, caller);
    return toAppointmentDetail(appointment);
  }

  /**
   * **给评价域（P3 Task 34）复用**：取一条预约并做可见性断言，返回实体。
   *
   * 与 {@link findOne} 同一套守卫（404 / 32001 → 403 / 32002），区别只是
   * 返回实体而不是 DTO——评价要读 `studentPersonId` / `mentorProfileId` / `status`。
   *
   * 单独开这个口子，是为了让「可见性」只有一处实现：评价域再抄一份
   * `assertAppointmentVisible` 的话，两处迟早会对「管理员算不算可见」给出不同答案。
   */
  async findVisibleEntity(
    id: bigint,
    caller: RequestUser,
  ): Promise<AppointmentWithStudent> {
    const appointment = await this.repository.findWithStudentById(id);
    if (appointment === null) {
      throw this.appointmentNotFound();
    }
    await this.assertAppointmentVisible(appointment, caller);
    return appointment;
  }

  /**
   * 列表的行级过滤：先算**有效数据范围**（角色范围与 `@DataScope('all')`
   * 求窄），再按上表译成 where 片段。`self` 时才走身份链多查两次
   * （人 → 导师档案），其余范围一次查询都不多发。
   */
  private async resolveListFilter(
    caller: RequestUser,
  ): Promise<AppointmentListFilter> {
    const user = await this.users.findById(caller.userId);
    const scope = await this.dataScope.resolve(
      {
        userId: caller.userId,
        isSuperAdmin: caller.isSuperAdmin,
        deptId: user?.deptId ?? null,
      },
      currentDataScopeCeiling(),
    );

    if (scope.kind === 'all') {
      return { kind: 'all' };
    }
    if (scope.kind === 'depts') {
      return { kind: 'depts', deptIds: scope.deptIds };
    }

    // `self`：有导师档案 → 导师视角；否则学生视角（解析不出人 → 空集）
    const person =
      user === null
        ? null
        : await this.repository.findPersonByLogin(user.username);
    if (person === null) {
      return { kind: 'student', studentPersonId: null };
    }
    const profile = await this.repository.findProfileByPersonId(person.id);
    if (profile !== null) {
      return { kind: 'mentor', mentorProfileIds: [profile.id] };
    }
    return { kind: 'student', studentPersonId: person.id };
  }

  /**
   * `POST /appointments/:id/materials`（Task 29，学生传预约材料）。
   *
   * 守卫**先到先拒**（404 → 403 → 409）：
   *   0. 天花板绊线：`@DataScope('self')` 被改宽时宁可 403 / 10003
   *   1. 预约不存在 / 已软删 → 404 / 32001
   *   2. 调用者不是**申请人本人** → 403 / 32002
   *   3. `status ∈ {6,7,8,9}`（终态）→ 409 / 32003；非终态才许挂
   *   4. `assertOwnedBy(fileId, 'Appointment', id)` → 404 / 28101
   *   5. 同一 fileId 本预约下已有未删行 → 409 / 32006（并发由 DB 唯一键兜底，同码）
   *
   * 文件归属锚点是 `SysFile.ownerType = 'Appointment'` + `ownerId = 预约 id`
   * （PascalCase 一字不差，大小写敏感；**不是** Task 16 的 `'MentorApplication'`）。
   */
  async attachAppointmentMaterial(
    id: bigint,
    dto: AttachAppointmentMaterialDto,
    caller: RequestUser,
  ): Promise<AppointmentMaterialResponseDto> {
    const appointment = await this.authorizeApplicant(id, caller);

    // 守卫 3：终态（6/7/8/9）不许再挂材料
    if (TERMINAL_APPOINTMENT_STATUSES.includes(appointment.status)) {
      throw this.transitionInvalid();
    }

    // 守卫 4：文件必须是**本预约**的附件（不存在 / 无归属 / 归属不符同 404 / 28101）
    await this.fileService.assertOwnedBy(
      dto.fileId,
      APPOINTMENT_OWNER_TYPE,
      String(id),
    );

    const fileId = BigInt(dto.fileId);
    if (
      await this.repository.hasActiveAppointmentMaterial(appointment.id, fileId)
    ) {
      throw this.duplicateMaterial();
    }

    let created: AppointmentMaterial;
    try {
      created = await this.repository.createAppointmentMaterial({
        appointmentId: appointment.id,
        fileId,
        kind: dto.kind,
      });
    } catch (error) {
      // 并发兜底：两个请求都过了上面的「先查后插」，唯一键只放一方进来。
      // 撞的是 `uk_appointment_material_file_active`（P2002），映射成与预检同码的
      // 409 / 32006，而不是让 Prisma 的 10006 或 500 漏给前端。
      this.rethrowIfMaterialDuplicate(error);
      throw error;
    }
    const files = await this.repository.findFilesByIds([created.fileId]);
    return toAppointmentMaterialResponse(created, files[0] ?? null);
  }

  /**
   * `POST /appointments/:id/record/materials`（Task 29，导师传过程材料）。
   *
   * 守卫**先到先拒**（404 → 403 → 409）：
   *   0. 天花板绊线：`@DataScope('self')` 被改宽时宁可 403 / 10003
   *   1. 预约不存在 / 已软删 → 404 / 32001
   *   2. 调用者不是**该预约的导师本人** → 403 / 32002
   *   3. 记录必须已存在：`status ∈ {3,4,5,6}`；`0` / `1`（还没填记录）及其余
   *      → 409 / 32003
   *   4. `assertOwnedBy(fileId, 'Appointment', id)` → 404 / 28101
   *   5. 同一 fileId 本记录下已有未删行 → 409 / 32006（并发由 DB 唯一键兜底，同码）
   *
   * 过程材料挂在**指导记录**上（`GuidanceMaterial.recordId`），但文件归属锚点
   * 仍是这条**预约**（`ownerType='Appointment'` + `ownerId=预约 id`）。
   * `GuidanceMaterial` 没有分类列，过程材料**永不分类**（`kind` 恒 null）。
   */
  async attachRecordMaterial(
    id: bigint,
    dto: AttachRecordMaterialDto,
    caller: RequestUser,
  ): Promise<AppointmentMaterialResponseDto> {
    const { appointment } = await this.authorizeMentor(id, caller);

    // 守卫 3：记录已存在（3/4/5/6）才许挂过程材料
    if (!RECORD_MATERIAL_STATUSES.includes(appointment.status)) {
      throw this.transitionInvalid();
    }
    const record = await this.repository.findRecordRowByAppointmentId(
      appointment.id,
    );
    if (record === null) {
      // 状态在 3-6 却没有记录：人为不一致，按「记录还不存在」处理
      throw this.transitionInvalid();
    }

    // 守卫 4：文件必须归属**本预约**
    await this.fileService.assertOwnedBy(
      dto.fileId,
      APPOINTMENT_OWNER_TYPE,
      String(id),
    );

    const fileId = BigInt(dto.fileId);
    if (await this.repository.hasActiveGuidanceMaterial(record.id, fileId)) {
      throw this.duplicateMaterial();
    }

    let created: GuidanceMaterial;
    try {
      created = await this.repository.createGuidanceMaterial({
        recordId: record.id,
        fileId,
      });
    } catch (error) {
      // 并发兜底：撞 `uk_guidance_material_file_active` → 与预检同码的 409 / 32006
      this.rethrowIfMaterialDuplicate(error);
      throw error;
    }
    const files = await this.repository.findFilesByIds([created.fileId]);
    return toGuidanceMaterialResponse(created, files[0] ?? null);
  }

  /**
   * `GET /appointments/:id/materials`（Task 29）——**一次返回两类材料**，
   * 每条带 `source` 字段：`'appointment'`（预约材料）/ `'record'`（过程材料）。
   *
   * 守卫：预约不存在 / 已软删 → 404 / 32001；可见性三选一（申请人本人 /
   * 该预约的导师本人 / 数据范围覆盖**申请人部门**的管理员）否则 403 / 32002
   * ——口径与 `GET /record` 完全一致（{@link assertAppointmentVisible}）。
   *
   * **不分页**（材料是子资源、条数有界）：沿用 RES-06 的「全量一页」形状，
   * `page` 恒 1、`pageSize` = total。
   */
  async listMaterials(
    id: bigint,
    caller: RequestUser,
  ): Promise<AppointmentMaterialListResponseDto> {
    const appointment = await this.repository.findWithStudentById(id);
    if (appointment === null) {
      throw this.appointmentNotFound();
    }
    await this.assertAppointmentVisible(appointment, caller);

    const appointmentRows = await this.repository.findAppointmentMaterials(id);
    const record = await this.repository.findRecordRowByAppointmentId(id);
    const recordRows =
      record === null
        ? []
        : await this.repository.findGuidanceMaterials(record.id);

    const files = await this.repository.findFilesByIds([
      ...appointmentRows.map((row) => row.fileId),
      ...recordRows.map((row) => row.fileId),
    ]);
    const fileById = new Map(files.map((file) => [file.id, file]));

    const list = [
      ...appointmentRows.map((row) =>
        toAppointmentMaterialResponse(row, fileById.get(row.fileId) ?? null),
      ),
      ...recordRows.map((row) =>
        toGuidanceMaterialResponse(row, fileById.get(row.fileId) ?? null),
      ),
    ];
    return { list, total: list.length, page: 1, pageSize: list.length };
  }

  /** `GET /mentor/records`：导师本人的指导记录列表 */
  async listMentorRecords(
    caller: RequestUser,
    query: QueryMentorRecordDto,
  ): Promise<MentorRecordListResponseDto> {
    const profile = await this.resolveCallerProfile(caller);
    if (profile === null) {
      throw this.appointmentForbidden();
    }
    const { rows, total } = await this.repository.findMentorGuidanceRecords(
      profile.id,
      {
        ...(query.from === undefined ? {} : { from: new Date(query.from) }),
        ...(query.to === undefined ? {} : { to: new Date(query.to) }),
        ...(query.type === undefined ? {} : { type: query.type }),
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      },
    );
    return {
      list: rows.map((row) => this.toMentorRecord(row)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** `GET /mentor/records/export`：导师本人指导记录 CSV */
  async exportMentorRecords(
    caller: RequestUser,
    query: QueryMentorRecordDto,
  ): Promise<{
    filename: string;
    header: string[];
    rows: unknown[][];
  }> {
    const profile = await this.resolveCallerProfile(caller);
    if (profile === null) {
      throw this.appointmentForbidden();
    }
    const maxRows = await this.sysConfig.getNumber('export.max_rows', 50000);
    const { rows } = await this.repository.findMentorGuidanceRecords(
      profile.id,
      {
        ...(query.from === undefined ? {} : { from: new Date(query.from) }),
        ...(query.to === undefined ? {} : { to: new Date(query.to) }),
        ...(query.type === undefined ? {} : { type: query.type }),
        skip: 0,
        take: maxRows + 1,
      },
    );
    if (rows.length > maxRows) {
      throw new BusinessException(
        ErrorCode.EXPORT_TOO_LARGE,
        '导出结果超过上限，请缩小查询范围',
        HttpStatus.CONFLICT,
      );
    }
    return {
      filename: csvFilename('mentor-records', 'self'),
      header: [
        '预约ID',
        '学生',
        '学号',
        '预约类型',
        '实际指导时间',
        '指导方式',
        '时长(分钟)',
        '核心指导内容',
        '后续指导建议',
      ],
      rows: rows.map((row) => [
        row.appointmentId,
        row.appointment.student.realName,
        row.appointment.student.login,
        row.appointment.type,
        row.actualTime,
        row.mode === 1 ? '线上' : '线下',
        row.durationMinutes,
        row.coreContent,
        row.followUp,
      ]),
    };
  }

  private toMentorRecord(row: {
    appointmentId: bigint;
    appointment: {
      type: number;
      status: number;
      student: { realName: string; login: string };
    };
    actualTime: Date;
    mode: number;
    coreContent: string;
    followUp: string;
    durationMinutes: number;
  }): {
    appointmentId: string;
    studentName: string;
    studentLogin: string;
    type: number;
    status: number;
    actualTime: string;
    mode: number;
    coreContent: string;
    followUp: string;
    durationMinutes: number;
  } {
    return {
      appointmentId: row.appointmentId.toString(),
      studentName: row.appointment.student.realName,
      studentLogin: row.appointment.student.login,
      type: row.appointment.type,
      status: row.appointment.status,
      actualTime: row.actualTime.toISOString(),
      mode: row.mode,
      coreContent: row.coreContent,
      followUp: row.followUp,
      durationMinutes: row.durationMinutes,
    };
  }

  /** 预览预约材料（学生上传）：可见性同 listMaterials */
  async previewAppointmentMaterial(
    id: bigint,
    materialId: bigint,
    caller: RequestUser,
  ): Promise<StreamableFile> {
    return this.serveAppointmentMaterial(id, materialId, caller, 'inline');
  }

  /** 下载预约材料（学生上传）：可见性同 listMaterials */
  async downloadAppointmentMaterial(
    id: bigint,
    materialId: bigint,
    caller: RequestUser,
  ): Promise<StreamableFile> {
    return this.serveAppointmentMaterial(
      id,
      materialId,
      caller,
      'attachment',
      'application/octet-stream',
    );
  }

  /** 预览过程材料（导师上传）：可见性同 listMaterials */
  async previewRecordMaterial(
    id: bigint,
    materialId: bigint,
    caller: RequestUser,
  ): Promise<StreamableFile> {
    return this.serveRecordMaterial(id, materialId, caller, 'inline');
  }

  /** 下载过程材料（导师上传）：可见性同 listMaterials */
  async downloadRecordMaterial(
    id: bigint,
    materialId: bigint,
    caller: RequestUser,
  ): Promise<StreamableFile> {
    return this.serveRecordMaterial(
      id,
      materialId,
      caller,
      'attachment',
      'application/octet-stream',
    );
  }

  private async serveAppointmentMaterial(
    id: bigint,
    materialId: bigint,
    caller: RequestUser,
    disposition: 'inline' | 'attachment',
    type?: string,
  ): Promise<StreamableFile> {
    const appointment = await this.repository.findWithStudentById(id);
    if (appointment === null) {
      throw this.appointmentNotFound();
    }
    await this.assertAppointmentVisible(appointment, caller);

    const material = await this.repository.findAppointmentMaterialById(
      id,
      materialId,
    );
    if (material === null) {
      throw this.materialNotFound();
    }
    await this.fileService.assertOwnedBy(
      material.fileId.toString(),
      'Appointment',
      id.toString(),
    );
    return this.fileService.serve(material.fileId, disposition, type);
  }

  private async serveRecordMaterial(
    id: bigint,
    materialId: bigint,
    caller: RequestUser,
    disposition: 'inline' | 'attachment',
    type?: string,
  ): Promise<StreamableFile> {
    const appointment = await this.repository.findWithStudentById(id);
    if (appointment === null) {
      throw this.appointmentNotFound();
    }
    await this.assertAppointmentVisible(appointment, caller);

    const record = await this.repository.findRecordRowByAppointmentId(id);
    if (record === null) {
      throw this.recordNotFound();
    }
    const material = await this.repository.findGuidanceMaterialById(
      record.id,
      materialId,
    );
    if (material === null) {
      throw this.guidanceMaterialNotFound();
    }
    await this.fileService.assertOwnedBy(
      material.fileId.toString(),
      'Appointment',
      id.toString(),
    );
    return this.fileService.serve(material.fileId, disposition, type);
  }

  /**
   * `DELETE /appointments/:id/materials/:materialId`（Task 29）——学生摘**预约材料**。
   *
   * 权限码 `appointment:create` 由控制器上的 `@RequirePermission` 声明（权限守卫
   * 是第一道闸）；本方法只补**归属**：调用者必须是该预约的**申请人本人**。
   *
   * 守卫**先到先拒**（404 → 403 → 404）：
   *   0. 天花板绊线：`@DataScope('self')` 被改宽时宁可 403 / 10003
   *   1. 预约不存在 / 已软删 → 404 / 32001
   *   2. 不是申请人本人 → 403 / 32002（先于材料查询，不泄露材料是否存在）
   *   3. 材料在本预约下不存在 / 已软删 → 404 / 32005
   *
   * 摘除是**软删**，不动 `SysFile`；摘后同一 fileId 允许再挂（唯一性按未删行算）。
   */
  async removeAppointmentMaterial(
    id: bigint,
    materialId: bigint,
    caller: RequestUser,
  ): Promise<DeleteAppointmentMaterialResponseDto> {
    await this.assertSelfCeiling(caller);

    const appointment = await this.repository.findById(id);
    if (appointment === null) {
      throw this.appointmentNotFound();
    }
    await this.assertApplicantOf(appointment, caller);

    const material = await this.repository.findAppointmentMaterialById(
      id,
      materialId,
    );
    if (material === null) {
      throw this.materialNotFound();
    }
    await this.repository.softDeleteAppointmentMaterial(material.id);
    return {
      id: materialId.toString(),
      source: MATERIAL_SOURCE.APPOINTMENT,
    };
  }

  /**
   * `DELETE /appointments/:id/record/materials/:materialId`（Task 29）——导师摘
   * **过程材料**。
   *
   * 权限码 `appointment:handle` 由控制器上的 `@RequirePermission` 声明；本方法只补
   * **归属**：调用者必须是该预约的**导师本人**。
   *
   * 守卫**先到先拒**（404 → 403 → 404）：
   *   0. 天花板绊线：`@DataScope('self')` 被改宽时宁可 403 / 10003
   *   1. 预约不存在 / 已软删 → 404 / 32001
   *   2. 不是该预约的导师本人 → 403 / 32002（先于材料查询）
   *   3. 记录不存在，或材料在本记录下不存在 / 已软删 → 404 / 33002
   *
   * 摘除是**软删**，不动 `SysFile`；摘后同一 fileId 允许再挂。
   */
  async removeRecordMaterial(
    id: bigint,
    materialId: bigint,
    caller: RequestUser,
  ): Promise<DeleteAppointmentMaterialResponseDto> {
    await this.assertSelfCeiling(caller);

    const appointment = await this.repository.findById(id);
    if (appointment === null) {
      throw this.appointmentNotFound();
    }
    await this.assertMentorOf(appointment, caller);

    const record = await this.repository.findRecordRowByAppointmentId(id);
    const material =
      record === null
        ? null
        : await this.repository.findGuidanceMaterialById(record.id, materialId);
    if (material === null) {
      throw this.guidanceMaterialNotFound();
    }
    await this.repository.softDeleteGuidanceMaterial(material.id);
    return { id: materialId.toString(), source: MATERIAL_SOURCE.RECORD };
  }

  /**
   * **超时扫描**（Task 25 / R17，Task 25b / R12 + R38，P3 Task 34 / R52）——
   * 把两类超时预约批量推进到 `9 EXPIRED`、第三类推进到 `6 COMPLETED`：
   *
   * 1. `0 PENDING` 且 `createdAt < now − appointment.pending_ttl_hours`（默认 72）；
   * 2. `1 CONFIRMED` 且 `requestedTime < now − appointment.confirmed_grace_hours`
   *    （默认 24）——**基准是约定时间 `requestedTime`，不是 `createdAt`**。
   *    已确认的预约到了约定时间还没有记录，不该永远停在 `1`：导师可以无限期后补，
   *    `actualTime` 会落在久远的过去，等于把没发生的事写成发生了（R38）。
   * 3. `4 STUDENT_CONFIRMED` 且 `updatedAt < now − appointment.review_ttl_days`
   *    （默认 30）→ `6 COMPLETED`。这不是惩罚，是**关窗**：评价只在 `4` 上可写，
   *    学生长期不评价的话预约会永久停在 `4`，完成率与工作量统计全部失真（R52）。
   *
   * 取配置走 {@link SysConfigService.getNumber}（缺行 / 停用 / 非 number 都回默认值），
   * 不在本模块自己查表。两条规则的命中数相加后返回。
   *
   * **可直接调用**：定时器只是它的一个调用者，e2e 直接调本方法即可确定性地
   * 验证「跑一次能推进、再跑一次不动」。`now` **只给测试用，生产路径不得传**：
   * 审计扩展在 create 时会把 `createdAt` 重写成当前时间（DB-06），要造「很老的
   * 预约」只能改 `createdAt`，而那是裸 SQL；把时钟往后推是等价且确定的做法。
   *
   * **三个配置都按 `Math.max(0, …)` clamp**（R34）：`SysConfig` 的
   * `parseNumberValue` 接受负数，不 clamp 的话 `cutoff = now − (−1)h = now + 1h`，
   * **刚创建的行会被立刻扫成 `9 EXPIRED`**——`9` 是终态、不可逆，且只有一条
   * info 日志。`0` 保持原语义（cutoff = now，把已存在的行全部扫掉）。
   *
   * 幂等与「只扫对应出发态」由 Repository 的两条条件更新保证（见
   * {@link AppointmentRepository.expirePendingBefore} /
   * {@link AppointmentRepository.expireConfirmedBefore}）。
   */
  async expireOverdue(
    now: Date = new Date(),
  ): Promise<{ expired: number; completed: number }> {
    const ttlHours = Math.max(
      0,
      await this.sysConfig.getNumber(
        PENDING_TTL_CONFIG_CODE,
        DEFAULT_PENDING_TTL_HOURS,
      ),
    );
    const graceHours = Math.max(
      0,
      await this.sysConfig.getNumber(
        CONFIRMED_GRACE_CONFIG_CODE,
        DEFAULT_CONFIRMED_GRACE_HOURS,
      ),
    );
    // P3 Task 34 / R52：评价窗口到期 → `4` 推进到 `6`（关窗，不写评价）
    const reviewDays = Math.max(
      0,
      await this.sysConfig.getNumber(
        REVIEW_TTL_CONFIG_CODE,
        DEFAULT_REVIEW_TTL_DAYS,
      ),
    );

    const expiredPending = await this.repository.expirePendingBefore(
      new Date(now.getTime() - ttlHours * MS_PER_HOUR),
    );
    const expiredConfirmed = await this.repository.expireConfirmedBefore(
      new Date(now.getTime() - graceHours * MS_PER_HOUR),
    );
    const completed = await this.repository.expireStudentConfirmedBefore(
      new Date(now.getTime() - reviewDays * MS_PER_DAY),
    );
    return { expired: expiredPending + expiredConfirmed, completed };
  }

  /**
   * 预约处理（confirm / reject / reschedule）共用的守卫链，**先到先拒**：
   *   0. 天花板绊线：`@DataScope('self')` 被改宽时宁可 403 / 10003
   *   1. 预约不存在 / 已软删 → 404 / 32001
   *   2. 调用者不是该预约的导师本人 → 403 / 32002（与「不存在」分开）
   *   3. `status != 0 PENDING` → 409 / 32003
   *
   * 第 0 条不是业务判据，是编码错误的兜底（同 create / mentor-slot），因此先于
   * 第 1 条——它只在装饰器被改宽时触发，正常路径一条查询都不多发。
   */
  private async authorizeHandle(
    id: bigint,
    caller: RequestUser,
  ): Promise<Appointment> {
    const scope = await this.dataScope.resolve(
      {
        userId: caller.userId,
        isSuperAdmin: caller.isSuperAdmin,
        deptId: null,
      },
      currentDataScopeCeiling(),
    );
    if (scope.kind !== 'self' || scope.userId !== caller.userId) {
      throw this.forbidden();
    }

    // 守卫 1：预约不存在 / 已软删 → 404 / 32001
    const appointment = await this.repository.findById(id);
    if (appointment === null) {
      throw this.appointmentNotFound();
    }

    // 守卫 2：不是该预约的导师本人（含「调用者不是导师 / 无档案」）→ 403 / 32002
    const profile = await this.resolveCallerProfile(caller);
    if (profile === null || profile.id !== appointment.mentorProfileId) {
      throw this.appointmentForbidden();
    }

    // 守卫 3：只有 PENDING（0）能处理 → 其余 409 / 32003
    if (appointment.status !== APPOINTMENT_STATUS.PENDING) {
      throw this.transitionInvalid();
    }

    return appointment;
  }

  /**
   * 学生取消的守卫链，**先到先拒**（404 → 403 → 409）：
   *   0. 天花板绊线：`@DataScope('self')` 被改宽时宁可 403 / 10003
   *   1. 预约不存在 / 已软删 → 404 / 32001
   *   2. 调用者不是**申请人本人** → 403 / 32002（别的学生、导师、管理员同一码）
   *   3. 出发态不在 `0 PENDING` / `1 CONFIRMED` → 409 / 32003
   *
   * 前三条与确认记录 / 提异议共用 {@link authorizeApplicant}；出发态是取消独有的。
   */
  private async authorizeCancel(
    id: bigint,
    caller: RequestUser,
  ): Promise<Appointment> {
    const appointment = await this.authorizeApplicant(id, caller);

    // 守卫 3：只有 0 / 1 能取消 → 其余 409 / 32003
    if (!CANCELLABLE_APPOINTMENT_STATUSES.includes(appointment.status)) {
      throw this.transitionInvalid();
    }

    return appointment;
  }

  /**
   * 学生确认记录 / 提异议的守卫链，**先到先拒**（404 → 403 → 409）：
   *   0. 天花板绊线：`@DataScope('self')` 被改宽时宁可 403 / 10003
   *   1. 预约不存在 / 已软删 → 404 / 32001
   *   2. 调用者不是**申请人本人** → 403 / 32002
   *   3. `status != 3 RECORD_SUBMITTED` → 409 / 32003（`0` / `1` / `4` / `6` 等一律拒绝）
   *
   * 第 2 条先于第 3 条：别人的、且已终态的预约必须给 403 / 32002 而不是 32003
   * ——「无权访问」比「状态不对」更根本。
   */
  private async authorizeRecordConfirmation(
    id: bigint,
    caller: RequestUser,
  ): Promise<Appointment> {
    const appointment = await this.authorizeApplicant(id, caller);

    // 守卫 3：只有 3 RECORD_SUBMITTED 能确认 / 提异议 → 其余 409 / 32003
    if (appointment.status !== APPOINTMENT_STATUS.RECORD_SUBMITTED) {
      throw this.transitionInvalid();
    }

    return appointment;
  }

  /**
   * 学生侧动作（取消 / 确认记录 / 提异议）共用的守卫链，**先到先拒**：
   *   0. 天花板绊线：`@DataScope('self')` 被改宽时宁可 403 / 10003
   *   1. 预约不存在 / 已软删 → 404 / 32001
   *   2. 调用者不是**申请人本人** → 403 / 32002（别的学生、导师、管理员同一码）
   *
   * 第 2 条用「`caller` 的 `SyncPerson.id` 是否等于 `appointment.studentPersonId`」
   * 判定，而不是先过「必须是学生」再比对：导师 / 管理员同样解析得出 `SyncPerson`，
   * 但 id 对不上就统一 403 / 32002——不会因为「不是学生」先漏成 403 / 10003。
   *
   * 出发态判定由调用方追加：取消是 `{0,1}`，确认记录 / 提异议是 `3`。
   */
  private async authorizeApplicant(
    id: bigint,
    caller: RequestUser,
  ): Promise<Appointment> {
    const scope = await this.dataScope.resolve(
      {
        userId: caller.userId,
        isSuperAdmin: caller.isSuperAdmin,
        deptId: null,
      },
      currentDataScopeCeiling(),
    );
    if (scope.kind !== 'self' || scope.userId !== caller.userId) {
      throw this.forbidden();
    }

    // 守卫 1：预约不存在 / 已软删 → 404 / 32001
    const appointment = await this.repository.findById(id);
    if (appointment === null) {
      throw this.appointmentNotFound();
    }

    // 守卫 2：不是申请人本人 → 403 / 32002
    const user = await this.users.findById(caller.userId);
    const person =
      user === null
        ? null
        : await this.repository.findPersonByLogin(user.username);
    if (person === null || person.id !== appointment.studentPersonId) {
      throw this.appointmentForbidden();
    }

    return appointment;
  }

  /**
   * 填报记录的守卫链，**先到先拒**（404 → 403 → 409）：
   *   0. 天花板绊线：`@DataScope('self')` 被改宽时宁可 403 / 10003
   *   1. 预约不存在 / 已软删 → 404 / 32001
   *   2. 调用者不是该预约的导师本人 → 403 / 32002（含「调用者不是导师 / 无档案」）
   *   3. 出发态不是 `1 CONFIRMED` / `3 RECORD_SUBMITTED` → 409 / 32003
   *      （`0` / `4` / `5` / `6` 等一律拒绝）
   *
   * 返回 `submitterPersonId`：`MentorProfile.personId` 就是该导师的
   * `SyncPerson.id`，直接作 `submittedBy`，不必再查一次人。
   *
   * 同时返回**出发态** `fromStatus`：调用方据此选「建记录 + 1→3」（R19）还是
   * 「更新记录、保持 3」（R37）。两者不能靠事务里「先试建、没命中再改」来分——
   * 那会让并发里输掉 `1 → 3` 的请求变成一次重填并返回 200。
   */
  private async authorizeRecordSubmit(
    id: bigint,
    caller: RequestUser,
  ): Promise<{ submitterPersonId: bigint; fromStatus: number }> {
    const scope = await this.dataScope.resolve(
      {
        userId: caller.userId,
        isSuperAdmin: caller.isSuperAdmin,
        deptId: null,
      },
      currentDataScopeCeiling(),
    );
    if (scope.kind !== 'self' || scope.userId !== caller.userId) {
      throw this.forbidden();
    }

    // 守卫 1：预约不存在 / 已软删 → 404 / 32001
    const appointment = await this.repository.findById(id);
    if (appointment === null) {
      throw this.appointmentNotFound();
    }

    // 守卫 2：不是该预约的导师本人 → 403 / 32002
    const profile = await this.resolveCallerProfile(caller);
    if (profile === null || profile.id !== appointment.mentorProfileId) {
      throw this.appointmentForbidden();
    }

    // 守卫 3：1 CONFIRMED（首次填报）/ 3 RECORD_SUBMITTED（R37 重填）→ 其余 409 / 32003
    if (
      appointment.status !== APPOINTMENT_STATUS.CONFIRMED &&
      appointment.status !== APPOINTMENT_STATUS.RECORD_SUBMITTED
    ) {
      throw this.transitionInvalid();
    }

    return {
      submitterPersonId: profile.personId,
      fromStatus: appointment.status,
    };
  }

  /**
   * 异议复核的守卫链，**先到先拒**（404 → 403 → 409）：
   *   1. 预约不存在 / 已软删 → 404 / 32001
   *   2. 数据范围不覆盖**申请人所在学院** → **403 / 10003**（`assertDeptVisible`，
   *      不是 404、也不是 32002——「没权限」要和「不存在」分开）
   *   3. `status != 5 DISPUTED` → 409 / 32003
   *
   * 数据范围口径（R14）：申请人部门 = `SyncPerson.orgUnit.deptId`。管理员天花板是
   * `@DataScope('dept')`（本部门**及下级**）；申请人没有部门投影时只有
   * `{kind:'all'}` 放行（fail-closed，同 mentor-application / mentor-material）。
   *
   * 先 404 后 403 与 brief 的点名一致：不存在的 `:id` 不泄露「有没有这条单」。
   */
  private async authorizeAdjudicate(
    id: bigint,
    caller: RequestUser,
  ): Promise<Appointment> {
    // 守卫 1：预约不存在 / 已软删 → 404 / 32001
    const appointment = await this.repository.findById(id);
    if (appointment === null) {
      throw this.appointmentNotFound();
    }

    // 守卫 2：申请人所在学院不在数据范围内 → 403 / 10003
    const user = await this.users.findById(caller.userId);
    const filter = await this.dataScope.resolve(
      {
        userId: caller.userId,
        isSuperAdmin: caller.isSuperAdmin,
        deptId: user?.deptId ?? null,
      },
      currentDataScopeCeiling(),
    );
    const applicantDeptId = await this.repository.findStudentOrgDeptId(
      appointment.studentPersonId,
    );
    if (applicantDeptId === null) {
      if (filter.kind !== 'all') {
        throw this.forbidden();
      }
    } else {
      this.dataScope.assertDeptVisible(filter, applicantDeptId);
    }

    // 守卫 3：只有 5 DISPUTED 能复核 → 其余 409 / 32003
    if (appointment.status !== APPOINTMENT_STATUS.DISPUTED) {
      throw this.transitionInvalid();
    }

    return appointment;
  }

  /**
   * 记录的**单条可见性**（Task 26 GET）：三选一放行，其余 403 / 32002。
   *
   * 1. 申请人本人（`SyncPerson.id === appointment.studentPersonId`）；
   * 2. 该预约的导师本人（`MentorProfile.id === appointment.mentorProfileId`）；
   * 3. 数据范围覆盖**申请人部门**的管理员——申请人部门 = `student.orgUnit.deptId`，
   *    没有部门投影时只有 `{kind:'all'}` 看得见（fail-closed，同
   *    `mentor-application.service` 的 `assertApplicantVisible`）。
   *
   * 不直接用 `DataScopeService.assertDeptVisible`：它抛的是 403 / **10003**，
   * 而本接口的契约是 403 / **32002**（「无权访问该预约」）。
   */
  private async assertRecordVisible(
    record: GuidanceRecordWithStudent,
    caller: RequestUser,
  ): Promise<void> {
    await this.assertAppointmentVisible(record.appointment, caller);
  }

  /**
   * 预约级的**单条可见性**（Task 26 GET 记录 / Task 29 GET 材料共用）：
   * 三选一放行，其余 403 / 32002。
   *
   * 1. 申请人本人（`SyncPerson.id === appointment.studentPersonId`）；
   * 2. 该预约的导师本人（`MentorProfile.id === appointment.mentorProfileId`）；
   * 3. 数据范围覆盖**申请人部门**的管理员——申请人部门 = `student.orgUnit.deptId`，
   *    没有部门投影时只有 `{kind:'all'}` 看得见（fail-closed，同
   *    `mentor-application.service` 的 `assertApplicantVisible`）。
   *
   * 不直接用 `DataScopeService.assertDeptVisible`：它抛的是 403 / **10003**，
   * 而本接口的契约是 403 / **32002**（「无权访问该预约」）。
   */
  private async assertAppointmentVisible(
    appointment: AppointmentWithStudent,
    caller: RequestUser,
  ): Promise<void> {
    const user = await this.users.findById(caller.userId);
    const person =
      user === null
        ? null
        : await this.repository.findPersonByLogin(user.username);

    // ① 申请人本人
    if (person !== null && person.id === appointment.studentPersonId) {
      return;
    }

    // ② 该预约的导师本人
    const profile =
      person === null
        ? null
        : await this.repository.findProfileByPersonId(person.id);
    if (profile !== null && profile.id === appointment.mentorProfileId) {
      return;
    }

    // ③ 数据范围覆盖申请人部门的管理员
    const scope = await this.dataScope.resolve(
      {
        userId: caller.userId,
        isSuperAdmin: caller.isSuperAdmin,
        deptId: user?.deptId ?? null,
      },
      currentDataScopeCeiling(),
    );
    const applicantDeptId = appointment.student.orgUnit?.deptId ?? null;
    if (applicantDeptId === null) {
      if (scope.kind === 'all') {
        return;
      }
      throw this.appointmentForbidden();
    }
    if (isDeptInFilter(scope, applicantDeptId)) {
      return;
    }
    throw this.appointmentForbidden();
  }

  /**
   * 身份链：`caller.userId` → `SysUser.username` → `SyncPerson.login` →
   * `personId` → `MentorProfile`。解析不出档案（学生 / 同步未及）返回 null，
   * 由调用方统一判 403 / 32002——这里**不抛 404**，否则「不是导师」会与
   * 「预约不存在」混成一个码。
   */
  private async resolveCallerProfile(
    caller: RequestUser,
  ): Promise<MentorProfile | null> {
    const user = await this.users.findById(caller.userId);
    if (user === null) {
      return null;
    }
    const person = await this.repository.findPersonByLogin(user.username);
    if (person === null) {
      return null;
    }
    return this.repository.findProfileByPersonId(person.id);
  }

  /**
   * 导师侧守卫链（Task 29 过程材料）：天花板绊线 → 404 / 32001 → 403 / 32002。
   *
   * 与 {@link authorizeHandle} 的区别：**不带状态门**——过程材料的可挂状态是
   * `{3,4,5,6}`（记录已存在），不是 PENDING；状态由调用方各自判。
   */
  private async authorizeMentor(
    id: bigint,
    caller: RequestUser,
  ): Promise<{ appointment: Appointment; profile: MentorProfile }> {
    await this.assertSelfCeiling(caller);

    const appointment = await this.repository.findById(id);
    if (appointment === null) {
      throw this.appointmentNotFound();
    }

    const profile = await this.resolveCallerProfile(caller);
    if (profile === null || profile.id !== appointment.mentorProfileId) {
      throw this.appointmentForbidden();
    }
    return { appointment, profile };
  }

  /**
   * 天花板绊线：`@DataScope('self')` 被改宽时宁可 403 / 10003。
   * 正常路径只做一次 `resolve`，不多发查询。
   */
  private async assertSelfCeiling(caller: RequestUser): Promise<void> {
    const scope = await this.dataScope.resolve(
      {
        userId: caller.userId,
        isSuperAdmin: caller.isSuperAdmin,
        deptId: null,
      },
      currentDataScopeCeiling(),
    );
    if (scope.kind !== 'self' || scope.userId !== caller.userId) {
      throw this.forbidden();
    }
  }

  /** 调用者是**申请人本人**吗？不是 → 403 / 32002（已载入 appointment 后使用） */
  private async assertApplicantOf(
    appointment: Appointment,
    caller: RequestUser,
  ): Promise<void> {
    const user = await this.users.findById(caller.userId);
    const person =
      user === null
        ? null
        : await this.repository.findPersonByLogin(user.username);
    if (person === null || person.id !== appointment.studentPersonId) {
      throw this.appointmentForbidden();
    }
  }

  /** 调用者是**该预约的导师本人**吗？不是 → 403 / 32002（已载入 appointment 后使用） */
  private async assertMentorOf(
    appointment: Appointment,
    caller: RequestUser,
  ): Promise<void> {
    const profile = await this.resolveCallerProfile(caller);
    if (profile === null || profile.id !== appointment.mentorProfileId) {
      throw this.appointmentForbidden();
    }
  }

  /**
   * 身份链 + 学生门（守卫 1）：`caller.userId` → `SysUser.username` →
   * `SyncPerson.login`。解析不出人、或 `personType != 'student'` → **403 / 10003**
   * （不是 404）：学生永远不会有导师档案，反过来导师 / 管理员也不该走这条学生入口。
   *
   * 天花板绊线同 mentor-slot：`@DataScope('self')` 被改宽时宁可 403。
   */
  private async resolveStudent(caller: RequestUser): Promise<SyncPerson> {
    const scope = await this.dataScope.resolve(
      {
        userId: caller.userId,
        isSuperAdmin: caller.isSuperAdmin,
        deptId: null,
      },
      currentDataScopeCeiling(),
    );
    if (scope.kind !== 'self' || scope.userId !== caller.userId) {
      throw this.forbidden();
    }

    const user = await this.users.findById(caller.userId);
    const person =
      user === null
        ? null
        : await this.repository.findPersonByLogin(user.username);
    if (person === null || person.personType !== 'student') {
      throw this.studentOnly();
    }
    return person;
  }

  /** 403 / 10003「无权限」：天花板绊线不过（@DataScope('self') 被改宽） */
  private forbidden(): BusinessException {
    return new BusinessException(
      ErrorCode.FORBIDDEN,
      '无权限',
      HttpStatus.FORBIDDEN,
    );
  }

  /** 403 / 10003：调用者不是学生（含导师 / 管理员 / 同步未及） */
  private studentOnly(): BusinessException {
    return new BusinessException(
      ErrorCode.FORBIDDEN,
      '只有学生可以发起预约',
      HttpStatus.FORBIDDEN,
    );
  }

  /** 404 / 32001「预约不存在」：不存在 / 已软删同码同文案（Task 24 守卫 1） */
  private appointmentNotFound(): BusinessException {
    return new BusinessException(
      ErrorCode.APPOINTMENT_NOT_FOUND,
      '预约不存在',
      HttpStatus.NOT_FOUND,
    );
  }

  /** 404 / 33001「指导记录不存在」：尚未填报 / 已软删（Task 26 GET 守卫 1） */
  private recordNotFound(): BusinessException {
    return new BusinessException(
      ErrorCode.GUIDANCE_RECORD_NOT_FOUND,
      '指导记录不存在',
      HttpStatus.NOT_FOUND,
    );
  }

  /** 403 / 32002「无权访问该预约」：不是该预约的导师本人（Task 24 守卫 2） */
  private appointmentForbidden(): BusinessException {
    return new BusinessException(
      ErrorCode.APPOINTMENT_FORBIDDEN,
      '无权访问该预约',
      HttpStatus.FORBIDDEN,
    );
  }

  /** 404 / 32005「预约材料不存在」：`:materialId` 不存在 / 已软删（预约侧摘材料） */
  private materialNotFound(): BusinessException {
    return new BusinessException(
      ErrorCode.APPOINTMENT_MATERIAL_NOT_FOUND,
      '预约材料不存在',
      HttpStatus.NOT_FOUND,
    );
  }

  /** 404 / 33002「过程材料不存在」：过程材料 `:materialId` 不存在 / 已软删 */
  private guidanceMaterialNotFound(): BusinessException {
    return new BusinessException(
      ErrorCode.GUIDANCE_MATERIAL_NOT_FOUND,
      '过程材料不存在',
      HttpStatus.NOT_FOUND,
    );
  }

  /**
   * 409 / 32006「该材料已挂接」：同一 fileId 重复挂到同一预约 / 同一记录。
   *
   * 两条来路同码：服务层的「先查后插」预检（更早、更便宜）与 DB-11 生成列唯一键
   * 的 P2002（并发兜底）。前端只需处理一种「已挂接」。
   */
  private duplicateMaterial(): BusinessException {
    return new BusinessException(
      ErrorCode.APPOINTMENT_MATERIAL_DUPLICATE,
      '该材料已挂接',
      HttpStatus.CONFLICT,
    );
  }

  /**
   * 材料插入撞 DB-11 生成列唯一键时，映射成 409 / 32006。
   *
   * `appointment_material` / `guidance_material` 的业务唯一键**只有**那条
   * `*_file_active`（另一条是主键），所以这里的 P2002 只可能是重复挂接——
   * 不像 `sys_user` 有三个业务唯一键要靠反查区分。非 P2002 原样抛回给调用方。
   */
  private rethrowIfMaterialDuplicate(error: unknown): void {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw this.duplicateMaterial();
    }
  }

  /** 409 / 32003「当前状态不允许该操作」：`status != 0 PENDING`（Task 24 守卫 3） */
  private transitionInvalid(): BusinessException {
    return new BusinessException(
      ErrorCode.APPOINTMENT_TRANSITION_INVALID,
      '当前状态不允许该操作',
      HttpStatus.CONFLICT,
    );
  }

  /** 404 / 31102「导师专业档案不存在」：复用 P1 的码与文案 */
  private profileNotFound(): BusinessException {
    return new BusinessException(
      ErrorCode.MENTOR_PROFILE_NOT_FOUND,
      '导师专业档案不存在',
      HttpStatus.NOT_FOUND,
    );
  }

  /** 409 / 31202：时段不存在 / 不属于该导师 / 已关闭 / 与期望时间不符 */
  private slotUnavailable(): BusinessException {
    return new BusinessException(
      ErrorCode.MENTOR_SLOT_UNAVAILABLE,
      '可指导时段不可用',
      HttpStatus.CONFLICT,
    );
  }

  /** 409 / 32004：该时段已被未终态预约占用 */
  private slotConflict(): BusinessException {
    return new BusinessException(
      ErrorCode.APPOINTMENT_SLOT_CONFLICT,
      '该时段已被预约占用',
      HttpStatus.CONFLICT,
    );
  }

  /** 409 / 32003：同一学生对同一导师已有未终态预约 */
  private duplicateAppointment(): BusinessException {
    return new BusinessException(
      ErrorCode.APPOINTMENT_TRANSITION_INVALID,
      '已有未完成的预约，不能重复发起',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * 终态（R12）：`6 COMPLETED` / `7 REJECTED` / `8 CANCELLED` / `9 EXPIRED`。
 * 学生挂预约材料的**状态门**：终态 → 409 / 32003（Task 29）。
 */
const TERMINAL_APPOINTMENT_STATUSES: readonly number[] = [
  APPOINTMENT_STATUS.COMPLETED,
  APPOINTMENT_STATUS.REJECTED,
  APPOINTMENT_STATUS.CANCELLED,
  APPOINTMENT_STATUS.EXPIRED,
];

/**
 * 导师挂过程材料允许的预约状态（Task 29）：`3 RECORD_SUBMITTED` /
 * `4 STUDENT_CONFIRMED` / `5 DISPUTED` / `6 COMPLETED`——这四个状态的共同点是
 * **指导记录已存在**（`0` / `1` 还没填记录，`2` 只是语义态，`7/8/9` 终态无记录）。
 */
const RECORD_MATERIAL_STATUSES: readonly number[] = [
  APPOINTMENT_STATUS.RECORD_SUBMITTED,
  APPOINTMENT_STATUS.STUDENT_CONFIRMED,
  APPOINTMENT_STATUS.DISPUTED,
  APPOINTMENT_STATUS.COMPLETED,
];

/**
 * 文件归属的业务对象类型（Task 29）。**PascalCase 一字不差、大小写敏感**：
 * Task 16 用的是 `'MentorApplication'`，预约材料 / 过程材料都用 `'Appointment'`
 * （过程材料也归属这条预约，不是指导记录）。
 */
const APPOINTMENT_OWNER_TYPE = 'Appointment';

/** `SysConfig` 里预约有效期的键（R17）：`0 PENDING` 超过这个小时数 → `9 EXPIRED` */
const PENDING_TTL_CONFIG_CODE = 'appointment.pending_ttl_hours';
/** TTL 缺省值（R17）：配置缺失 / 停用 / 类型不符时用它，不在调用点各自兜底 */
const DEFAULT_PENDING_TTL_HOURS = 72;

/**
 * `SysConfig` 里已确认预约的宽限期键（Task 25b / R38）：`1 CONFIRMED` 超过
 * 约定时间（`requestedTime`）这个小时数仍没有记录 → `9 EXPIRED`。
 */
const CONFIRMED_GRACE_CONFIG_CODE = 'appointment.confirmed_grace_hours';

/** 宽限期缺省值（Task 25b / R38）：配置缺失 / 停用 / 类型不符时用它 */
const DEFAULT_CONFIRMED_GRACE_HOURS = 24;

/**
 * `SysConfig` 里**评价窗口**的键（P3 Task 34 / R52）：`4 STUDENT_CONFIRMED`
 * 超过这个天数仍未评价 → `6 COMPLETED`（关窗，不写评价）。
 */
const REVIEW_TTL_CONFIG_CODE = 'appointment.review_ttl_days';

/** 评价窗口缺省值（R52）：30 天 */
const DEFAULT_REVIEW_TTL_DAYS = 30;

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** `Intl` 的英文短星期名 → 时段口径的 1-7（周日 7） */
const WEEKDAY_BY_NAME = new Map<string, number>([
  ['Mon', 1],
  ['Tue', 2],
  ['Wed', 3],
  ['Thu', 4],
  ['Fri', 5],
  ['Sat', 6],
  ['Sun', 7],
]);

/**
 * `requestedTime` 是否命中时段：按**业务时区**（`wallClock` 的 `timeZone`）
 * 取 weekday 与时刻，要求 weekday 相等且时刻落在半开区间
 * `[startTime, endTime)` 内（R31）。
 *
 * 不再用 `getUTCDay` / `getUTCHours`：那是把「墙钟时间」当成了 UTC 时刻。
 * `HH:mm` 定长字符串的字典序就是时间序，直接比较即可。
 */
function matchesSlot(
  requestedTime: Date,
  slot: Pick<MentorTimeSlot, 'weekday' | 'startTime' | 'endTime'>,
  wallClock: Intl.DateTimeFormat,
): boolean {
  const parts = wallClock.formatToParts(requestedTime);
  const weekdayName = parts.find((part) => part.type === 'weekday')?.value;
  const hour = parts.find((part) => part.type === 'hour')?.value;
  const minute = parts.find((part) => part.type === 'minute')?.value;
  if (weekdayName === undefined || hour === undefined || minute === undefined) {
    return false;
  }

  const weekday = WEEKDAY_BY_NAME.get(weekdayName);
  if (weekday === undefined) {
    return false;
  }

  const timeOfDay = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  return (
    weekday === slot.weekday &&
    timeOfDay >= slot.startTime &&
    timeOfDay < slot.endTime
  );
}
