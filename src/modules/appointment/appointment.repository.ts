import { Injectable } from '@nestjs/common';
import type {
  Appointment,
  AppointmentMaterial,
  GuidanceMaterial,
  GuidanceRecord,
  MentorProfile,
  MentorTimeSlot,
  Prisma,
  SyncOrgUnit,
  SyncPerson,
  SysFile,
} from '@prisma/client';
import { currentActorId } from '../../common/context/request-context';
import { PrismaService } from '../../infra/prisma/prisma.service';
import {
  CANCELLABLE_APPOINTMENT_STATUSES,
  NON_TERMINAL_APPOINTMENT_STATUSES,
  APPOINTMENT_STATUS,
} from './dto/create-appointment.dto';

/** 已生效的导师档案（MentorProfile.status = 2 APPROVED） */
const MENTOR_PROFILE_APPROVED = 2;

/** 开放时段（MentorTimeSlot.status：0 关闭 / 1 开放，同 Task 21） */
const SLOT_OPEN_STATUS = 1;

/**
 * 预约处理（Task 24）的可写列。三列都按需出现：
 * - `confirm` 写 `status` + `handleComment`；
 * - `reject` 写 `status` + `rejectReason`；
 * - `reschedule` 写 `proposedTime` + `handleComment`（**不碰 `requestedTime`**，R13）。
 *
 * 显式挑字段而不是透传 DTO（DTO-12）：客户端永远改不到 `studentPersonId` /
 * `requestedTime` / `slotId` 这些它不该碰的列。
 */
export interface AppointmentHandleWrite {
  status?: number;
  proposedTime?: Date;
  handleComment?: string | null;
  rejectReason?: string;
}

/**
 * 学生确认记录 / 提异议的可写列（Task 27）。`status` 只能落
 * `4 STUDENT_CONFIRMED` / `5 DISPUTED`；提异议时附带 `disputeReason`，
 * 确认记录时显式写 `null` 清掉上一轮未决的异议（R36）。
 * 显式挑字段（DTO-12）：客户端改不到 `studentPersonId` / `requestedTime` 等列。
 */
export interface AppointmentStudentActionWrite {
  status: number;
  disputeReason?: string | null;
}

/**
 * 管理员异议复核的可写列（Task 28）。`status` 只能落
 * `6 COMPLETED`（uphold）/ `3 RECORD_SUBMITTED`（return）；
 * `adjudicateComment` 是本次复核意见（必填，由 DTO 保证）。
 *
 * `disputeReason` 只在 **uphold** 时显式写 `null`——`5 → 6` 是终态，异议已裁决，
 * 「当前未决的异议」不存在了；`return`（`5 → 3`）**不传该字段**，R36 要求保留
 * 异议内容供导师重填时对照。
 *
 * 显式挑字段（DTO-12）：客户端改不到 `studentPersonId` / `requestedTime` 等列。
 */
export interface AppointmentAdjudicateWrite {
  status: number;
  adjudicateComment: string;
  disputeReason?: string | null;
}

/** 发起预约的可写列（`id` / `studentPersonId` 不来自请求，DTO-12 显式挑字段） */
export interface AppointmentCreateInput {
  studentPersonId: bigint;
  mentorProfileId: bigint;
  type: number;
  requestedTime: Date;
  topic: string;
  questions: string;
  mode: number;
  slotId: bigint;
}

/**
 * 落库结果。用判别联合而不是在事务里抛业务异常：调用方在事务外决定错误码，
 * 事务回调只表达「撞了哪条守卫」。
 */
export type AppointmentCreateResult =
  | { kind: 'created'; appointment: Appointment }
  | { kind: 'slot-conflict' }
  | { kind: 'student-conflict' };

/**
 * 指导记录 + 它所属的预约 + 申请人（Task 26）。`orgUnit` 用于 GET 的可见性
 * 判定（管理员按**申请人部门**放行）；它可能为 null（组织行被同步软删 / 投影
 * 未挂上），调用方按 fail-closed 处理。
 */
export type GuidanceRecordWithStudent = GuidanceRecord & {
  appointment: Appointment & {
    student: SyncPerson & { orgUnit: SyncOrgUnit | null };
  };
};

/**
 * 预约 + 申请人 + 申请人部门投影（Task 29 GET 材料的可见性判定）。
 * `orgUnit` 可能为 null（组织行被同步软删 / 投影未挂上），调用方按
 * fail-closed 处理——只有 `{kind:'all'}` 放行。
 */
export type AppointmentWithStudent = Appointment & {
  student: SyncPerson & { orgUnit: SyncOrgUnit | null };
};

/**
 * 列表 / 详情共用的联查形状（Task 30）：预约 + 申请人（含组织）+ 导师档案 +
 * 导师人（含组织）。
 *
 * 列表项的 `student` / `mentor` 与详情的「更全的学生信息」都从这三个联查里取，
 * 客户端改不到。`orgUnit` 类型上可空是防御（`orgUnitId` 是 NOT NULL 外键，
 * 只有同步层把组织行软删时才会出现「挂着一条看不到的组织」）。
 */
export type AppointmentWithParties = Appointment & {
  student: SyncPerson & { orgUnit: SyncOrgUnit | null };
  mentor: MentorProfile & {
    person: SyncPerson & { orgUnit: SyncOrgUnit | null };
  };
};

/**
 * `GET /appointments` 的行级过滤（Task 30）。
 *
 * 由服务按「有效数据范围 + 身份链」译好再传进来——repository 不认识角色，
 * 只认识 where 片段。**空数组 = 一行都看不见**（fail-closed），不是「不限」。
 */
export type AppointmentListFilter =
  /** 管理员（有效范围 all）：不加行级约束 */
  | { kind: 'all' }
  /** 学生视角：只看自己发起的。null = 同步未及 → 空集 */
  | { kind: 'student'; studentPersonId: bigint | null }
  /** 导师视角：只看约我的（mentorProfileId ∈ 我名下的档案） */
  | { kind: 'mentor'; mentorProfileIds: readonly bigint[] }
  /** 管理员（有效范围 dept / deptAndChildren）：按**申请人部门**收窄（R14） */
  | { kind: 'depts'; deptIds: readonly bigint[] };

/**
 * 列表 / 详情共用的联查：申请人（含组织）+ 导师档案 + 导师人（含组织）。
 * 抽成常量而不是每处手写：列表与详情的响应形状必须同源，漏一层 `orgUnit`
 * 就有一半字段静默变成空串。
 */
const APPOINTMENT_PARTIES_INCLUDE = {
  student: { include: { orgUnit: true } },
  mentor: { include: { person: { include: { orgUnit: true } } } },
} satisfies Prisma.AppointmentInclude;

/**
 * 列表 where。**抽成纯函数是为了能钉住条件的形状**（同
 * `buildApplicationListWhere`）：status / type 与视角过滤落在同一个 where 的
 * 不同键上，混在对象展开里后写的会静默吃掉先写的。
 */
export function buildAppointmentListWhere(params: {
  status?: number;
  type?: number;
  filter: AppointmentListFilter;
}): Prisma.AppointmentWhereInput {
  const clauses: Prisma.AppointmentWhereInput[] = [
    ...(params.status === undefined ? [] : [{ status: params.status }]),
    ...(params.type === undefined ? [] : [{ type: params.type }]),
    ...appointmentFilterClauses(params.filter),
  ];
  return clauses.length === 0 ? {} : { AND: clauses };
}

/**
 * 视角 → where 片段：
 * - `all` → 不加行级约束；
 * - `student` → `studentPersonId = 本人`（解析不出人时 `in: []` → 空集）；
 * - `mentor` → `mentorProfileId ∈ 我名下的档案`；
 * - `depts` → 申请人组织投影的部门在集合内（`student.orgUnit.deptId in deptIds`）。
 *
 * 空数组一律 `in: []`，Prisma 译成「一行都不返回」——这是 fail-closed 的落点。
 */
function appointmentFilterClauses(
  filter: AppointmentListFilter,
): Prisma.AppointmentWhereInput[] {
  if (filter.kind === 'all') {
    return [];
  }
  if (filter.kind === 'student') {
    return [
      {
        studentPersonId: {
          in: filter.studentPersonId === null ? [] : [filter.studentPersonId],
        },
      },
    ];
  }
  if (filter.kind === 'mentor') {
    return [{ mentorProfileId: { in: [...filter.mentorProfileIds] } }];
  }
  return [{ student: { orgUnit: { deptId: { in: [...filter.deptIds] } } } }];
}

/** 填报指导记录的可写列（DTO-12 显式挑字段：客户端改不到 `appointmentId` 以外的列） */
export interface GuidanceRecordCreateInput {
  appointmentId: bigint;
  actualTime: Date;
  mode: number;
  coreContent: string;
  followUp: string;
  /** 指导时长（分钟），P3 Task 35 / R58；`0` 表示未填 */
  durationMinutes: number;
  submittedBy: bigint;
  submittedAt: Date;
}

/**
 * 填报落库结果。判别联合而不是在事务里抛业务异常：调用方在事务外决定错误码。
 *
 * **唯一键冲突不在这里映射**（返工轮 1 / P2-7）：`uk_guidance_record_appointment_active`
 * 是生成列唯一键，Prisma 没有为它建模字段，`P2002` 的 `meta.target` 不可靠，
 * 无法把「这一条约束」与事务里其它 P2002 区分开。收窄不了就不该 catch——
 * 这条路径正常不可达（要「记录已存在但预约被拨回 1」的人为不一致），真触发了
 * 就让它冒成 500 被人看见，而不是伪装成 409「重复提交」把真实错误吞掉。
 * 重复提交本身由守卫 3 预检与条件更新的 `count = 0` 各自兜住，不依赖这里。
 */
export type GuidanceRecordSubmitResult =
  | { kind: 'created'; record: GuidanceRecordWithStudent }
  | { kind: 'updated'; record: GuidanceRecordWithStudent }
  | { kind: 'transition-invalid' };

/**
 * 预约的数据访问（Task 23）。
 *
 * `SyncPerson` / `MentorProfile` / `MentorTimeSlot` 的**读**在这里做（同
 * mentor-slot / mentor-search 的口径）：身份链与「导师 / 时段是否可用」是
 * 本模块判定的脊梁。**写**只有 `Appointment` 一张表，同步表一条写路径都没有。
 *
 * 读一律 `findFirst`（ESLint 禁 `findUnique`：软删除表塞不进 deletedAt 过滤）。
 */
@Injectable()
export class AppointmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 身份链第 2 步：SysUser.username → SyncPerson（自然键 login，精确匹配） */
  async findPersonByLogin(login: string): Promise<SyncPerson | null> {
    return this.prisma.client.syncPerson.findFirst({ where: { login } });
  }

  /**
   * 身份链第 3 步：SyncPerson.id → MentorProfile（一人一行，无档案即 null）。
   *
   * Task 24 用它判「调用者是不是该预约的导师本人」：调用者不是导师（无档案）
   * 也走 403 / 32002，而不是 404——「没权限」与「不存在」在这里要分开。
   */
  async findProfileByPersonId(personId: bigint): Promise<MentorProfile | null> {
    return this.prisma.client.mentorProfile.findFirst({ where: { personId } });
  }

  /**
   * 按主键取一条**未软删**的预约（Task 24 守卫 1）。
   *
   * 走 `client`（软删除扩展自动滤掉 `deletedAt` 非空的行）：已软删与不存在
   * 同判 null，调用方统一 404 / 32001。
   */
  async findById(id: bigint): Promise<Appointment | null> {
    return this.prisma.client.appointment.findFirst({ where: { id } });
  }

  /**
   * 申请人（`SyncPerson`）的**部门投影**：`orgUnit.deptId`（`SysDept.id`）。
   *
   * Task 28 的数据范围判定用它——管理员能复核的是「申请人所在学院」的单。
   * 人不存在 / 没挂组织 / 组织行没有部门投影一律回 `null`，调用方按
   * fail-closed 处理（只有 `{kind:'all'}` 放行）。
   *
   * 走 `client`：`SyncPerson` / `SyncOrgUnit` 已登记进 `SOFT_DELETE_MODELS`，
   * 已软删的人或组织不会被当成「没有部门」悄悄放行。
   */
  async findStudentOrgDeptId(personId: bigint): Promise<bigint | null> {
    const person = await this.prisma.client.syncPerson.findFirst({
      where: { id: personId },
      include: { orgUnit: true },
    });
    return person?.orgUnit?.deptId ?? null;
  }

  /**
   * 可预约的导师档案：**已生效（status=2）+ 未软删 + 人员未离场**。
   *
   * 软删扩展只过滤顶层模型，`person.deletedAt` 必须显式写——不写的话，
   * 已离场导师的档案仍是 status=2，会被当成可预约对象。
   */
  async findApprovedMentorById(id: bigint): Promise<MentorProfile | null> {
    return this.prisma.client.mentorProfile.findFirst({
      where: {
        id,
        status: MENTOR_PROFILE_APPROVED,
        person: { deletedAt: null },
      },
    });
  }

  /**
   * 按 `{ id, mentorProfileId }` 取一条未删时段。
   *
   * 归属不符（别人的时段）与不存在**同判 null**——调用方统一 409 / 31202
   * （R15 的「时段不属于该导师」与「时段不存在」对调用方是同一件事）。
   * `status` 由调用方判（0 关闭同样 409 / 31202）。
   */
  async findOwnedSlotById(
    id: bigint,
    mentorProfileId: bigint,
  ): Promise<MentorTimeSlot | null> {
    return this.prisma.client.mentorTimeSlot.findFirst({
      where: { id, mentorProfileId },
    });
  }

  /**
   * 落库 + 两条并发守卫（R78）。
   *
   * 事务**第一句**对**导师档案行** `SELECT … FOR UPDATE`（只读行锁，不写任何行、
   * 不刷新 `updatedAt`）：后到者阻塞到先到者提交后才建一致性读快照，随后的
   * `count` 能看到已提交的占用行。
   *
   * **为什么锁导师档案而不是时段行**：守卫 ⑤（时段占用）看 `slotId`，守卫 ⑥
   * （同学生同导师去重）看 `mentorProfileId`。锁时段行只能串行化同一时段的请求，
   * 两个**不同时段**的请求互不阻塞 → 双方都读到 student count = 0 → 同一学生对
   * 同一导师落下 2 条在途预约。锁导师行一把覆盖两条守卫；加第二把锁则要引入
   * 「先 A 后 B / 先 B 后 A」的死锁风险，除非严格定序。
   *
   * 锁的是**业务层**的 `mentor_profile`，不是同步层的 `sync_person`——不给同步层
   * 加锁。档案行存在性由调用方守卫 2 保证（不存在就到不了这里）。
   *
   * 裸 SQL 的边界（R78）：只许 `SELECT … FOR UPDATE` 这一种、只许在事务里当
   * 第一句、参数化绑定。**不用 `updateMany` 抢锁**——那会刷新 `updatedAt`，
   * 等于预约一次就改一次档案行的修改时间。
   */
  async createWithSlotLock(
    input: AppointmentCreateInput,
  ): Promise<AppointmentCreateResult> {
    return this.prisma.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM mentor_profile WHERE id = ${input.mentorProfileId} FOR UPDATE`;

      const slotInFlight = await tx.appointment.count({
        where: {
          slotId: input.slotId,
          status: { in: [...NON_TERMINAL_APPOINTMENT_STATUSES] },
        },
      });
      if (slotInFlight > 0) {
        return { kind: 'slot-conflict' };
      }

      const studentInFlight = await tx.appointment.count({
        where: {
          studentPersonId: input.studentPersonId,
          mentorProfileId: input.mentorProfileId,
          status: { in: [...NON_TERMINAL_APPOINTMENT_STATUSES] },
        },
      });
      if (studentInFlight > 0) {
        return { kind: 'student-conflict' };
      }

      const appointment = await tx.appointment.create({
        data: {
          studentPersonId: input.studentPersonId,
          mentorProfileId: input.mentorProfileId,
          type: input.type,
          status: APPOINTMENT_STATUS.PENDING,
          requestedTime: input.requestedTime,
          topic: input.topic,
          questions: input.questions,
          mode: input.mode,
          slotId: input.slotId,
          // 审计列由 Prisma 扩展按当前操作者重写（DB-05），这里是类型占位
          createdBy: 0n,
          updatedBy: 0n,
        },
      });
      return { kind: 'created', appointment };
    });
  }

  /**
   * **条件更新**一条预约的业务列（Task 24 返工轮 1）：只有 `status = 0 PENDING`
   * 才写，返回 null 表示「已经被别人处理过」——调用方据此 409 / 32003。
   *
   * 为什么不用「先读再写」：两个并发 `confirm` 都读到 `status=0`、都写 `1`，
   * 会**双 200**；而契约上第二个必须是 409。条件更新让 `UPDATE … WHERE
   * status = 0` 在库里原子判定，`count = 0` 就是「我输了这场竞争」。
   *
   * 为什么不用行锁（R32 的 `SELECT … FOR UPDATE`）：那是 P1 为「先 count 再
   * insert」准备的；这里是**单行状态迁移**，`updateMany` 的 `where` 本身就
   * 是判定条件，加锁只会多一把锁、多一处裸 SQL（R78：能不用就不用）。同
   * `mentor-application.repository.ts` 的 `applyTransition`。
   *
   * **只更新 `data` 里出现的列**——`reschedule` 因此不会碰 `requestedTime`
   * （R13：保留原值才能看出改了什么）。审计列 `updatedAt` / `updatedBy` 由
   * Prisma 扩展按当前操作者重写（DB-05），这里不写。软删行由扩展在
   * `updateMany` 的 `where` 上自动补 `deletedAt: null`，调用点不必重复写。
   */
  async updateIfPending(
    id: bigint,
    data: AppointmentHandleWrite,
  ): Promise<Appointment | null> {
    return this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.appointment.updateMany({
        where: { id, status: APPOINTMENT_STATUS.PENDING },
        data,
      });
      if (updated.count === 0) {
        return null;
      }
      return tx.appointment.findFirst({ where: { id } });
    });
  }

  /**
   * **学生取消**（Task 25 / R18）的条件更新：只有出发态是
   * `CANCELLABLE_APPOINTMENT_STATUSES`（`0 PENDING` / `1 CONFIRMED`）才写，
   * 落 `8 CANCELLED`；返回 null 表示「状态已经不在可取消集合里」——
   * 调用方据此 409 / 32003。
   *
   * 与 `updateIfPending` 同一套路（条件更新而不是行锁）：单行状态迁移，
   * `updateMany` 的 `where` 本身就是判定条件。出发态集合**只有一处定义**
   * （`create-appointment.dto.ts`），预检与落库不会各说各话。
   */
  async updateIfCancellable(id: bigint): Promise<Appointment | null> {
    return this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.appointment.updateMany({
        where: {
          id,
          status: { in: [...CANCELLABLE_APPOINTMENT_STATUSES] },
        },
        data: { status: APPOINTMENT_STATUS.CANCELLED },
      });
      if (updated.count === 0) {
        return null;
      }
      return tx.appointment.findFirst({ where: { id } });
    });
  }

  /**
   * **学生确认记录 / 提异议**（Task 27）的条件更新：只有出发态是
   * `3 RECORD_SUBMITTED` 才写，落 `4 STUDENT_CONFIRMED` / `5 DISPUTED`；
   * 返回 null 表示「状态已经不在 3」——调用方据此 409 / 32003。
   *
   * 与 `updateIfPending` / `updateIfCancellable` 同一套路（条件更新而不是行锁）：
   * 单行状态迁移，`updateMany` 的 `where` 本身就是判定条件，`count = 0` 就是
   * 「我输了这场并发竞争」。不加锁、不加裸 SQL（R78 / LAYER-09）。
   */
  async updateIfRecordSubmitted(
    id: bigint,
    data: AppointmentStudentActionWrite,
  ): Promise<Appointment | null> {
    return this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.appointment.updateMany({
        where: { id, status: APPOINTMENT_STATUS.RECORD_SUBMITTED },
        data,
      });
      if (updated.count === 0) {
        return null;
      }
      return tx.appointment.findFirst({ where: { id } });
    });
  }

  /**
   * **管理员异议复核**（Task 28）的条件更新：只有出发态是 `5 DISPUTED` 才写，
   * 落 `6 COMPLETED`（uphold）/ `3 RECORD_SUBMITTED`（return）；返回 null 表示
   * 「状态已经不在 5」——调用方据此 409 / 32003。
   *
   * 与 `updateIfRecordSubmitted` 同一套路（条件更新而不是行锁）：单行状态迁移，
   * `updateMany` 的 `where` 本身就是判定条件，`count = 0` 就是「我输了这场并发
   * 竞争」。两个并发 `adjudicate` 只有一方能命中 `status = 5`，另一方 409。
   *
   * **只更新 `data` 里出现的列**：`return` 分支不传 `disputeReason`，于是 R36 的
   * 「退回保留异议内容」由「不写」保证，而不是把原值再读出来写一遍。
   */
  async updateIfDisputed(
    id: bigint,
    data: AppointmentAdjudicateWrite,
  ): Promise<Appointment | null> {
    return this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.appointment.updateMany({
        where: { id, status: APPOINTMENT_STATUS.DISPUTED },
        data,
      });
      if (updated.count === 0) {
        return null;
      }
      return tx.appointment.findFirst({ where: { id } });
    });
  }

  /**
   * 按预约取**唯一一条**未软删的指导记录，并带上申请人信息（Task 26 GET）。
   *
   * 走 `client`（软删除扩展自动滤掉 `deletedAt` 非空的行）：已软删与不存在
   * 同判 null，调用方统一 404 / 33001。
   */
  async findRecordByAppointmentId(
    appointmentId: bigint,
  ): Promise<GuidanceRecordWithStudent | null> {
    return this.prisma.client.guidanceRecord.findFirst({
      where: { appointmentId },
      include: {
        appointment: {
          include: { student: { include: { orgUnit: true } } },
        },
      },
    });
  }

  /**
   * **填报指导记录**（Task 26 / R19）：一次事务里先做 `1 CONFIRMED → 3
   * RECORD_SUBMITTED` 的条件更新，再建记录。
   *
   * 为什么先条件更新：`1 → 3` 是**一步**（跳过 `2 IN_PROGRESS` 的可观测性），
   * 且状态判定与写入必须原子。`updateMany({ where: { id, status: 1 } })` 的
   * `count = 0` 就是「预约已经不在 1 态」——调用方据此 409 / 32003。
   *
   * 唯一键 `uk_guidance_record_appointment_active` 是**生成列唯一键**，Prisma
   * 不在 `appointmentId` 上建模，所以重复提交**不能**靠 P2002 作为主判据；
   * 正常路径由 `count = 0` 判。**不 catch P2002**：`meta.target` 无法可靠地
   * 定位到这一条约束，catch 会把事务里任何唯一键错误都伪装成 409。真撞上时
   * `$transaction` 自动回滚，状态更新一并撤销，错误按 500 冒出来（返工轮 1 /
   * P2-7）。
   */
  async createRecordWithTransition(
    input: GuidanceRecordCreateInput,
  ): Promise<GuidanceRecordSubmitResult> {
    return this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.appointment.updateMany({
        where: {
          id: input.appointmentId,
          status: APPOINTMENT_STATUS.CONFIRMED,
        },
        data: { status: APPOINTMENT_STATUS.RECORD_SUBMITTED },
      });
      if (updated.count === 0) {
        return { kind: 'transition-invalid' } as const;
      }

      const record = await tx.guidanceRecord.create({
        data: {
          appointmentId: input.appointmentId,
          actualTime: input.actualTime,
          mode: input.mode,
          coreContent: input.coreContent,
          followUp: input.followUp,
          durationMinutes: input.durationMinutes,
          submittedBy: input.submittedBy,
          submittedAt: input.submittedAt,
          // 审计列由 Prisma 扩展按当前操作者重写（DB-05），这里是类型占位
          createdBy: 0n,
          updatedBy: 0n,
        },
        include: {
          appointment: {
            include: { student: { include: { orgUnit: true } } },
          },
        },
      });
      return { kind: 'created', record } as const;
    });
  }

  /**
   * **记录重填**（Task 28 / R37）：预约停在 `3 RECORD_SUBMITTED` 时，导师重新
   * 提交指导记录——更新同一 `appointmentId` 的那一条记录，**状态保持 3**。
   *
   * 与 {@link createRecordWithTransition} 分开而不是在一个方法里二选一：路径由
   * **守卫读到的出发态**决定（`1` → 建、`3` → 改）。若在事务里「先试 `1 → 3`，
   * 没命中再试 `3`」，一个并发里输掉 `1 → 3` 的请求会顺势落进重填分支、返回 200
   * ——`POST /record` 原有的「并发双发恰一次 201 + 一次 409」契约就被悄悄改掉了。
   * 让调用方按出发态选方法，条件更新的 `where` 仍然兜住「读与写之间状态变了」：
   * 命中 0 行 → `transition-invalid` → 调用方 409 / 32003。
   *
   * 一次事务三笔：先用 `status = 3` 的条件更新「认领」这次重填（并发里若学生恰好
   * 确认记录推进到 4，这里会 `count = 0` 而放弃，不会覆盖已确认的记录）；再按
   * `appointmentId` 更新唯一那条记录的业务列与 `submittedAt`；最后带着申请人信息
   * 读回（响应形状与首次填报一致，R27）。
   *
   * 记录不存在（状态是 3 却没有记录，人为不一致）同样回 `transition-invalid`——
   * 不回退成「建一条」：那会把数据不一致伪装成一次正常重填。
   */
  async updateRecordWithTransition(
    input: GuidanceRecordCreateInput,
  ): Promise<GuidanceRecordSubmitResult> {
    return this.prisma.client.$transaction(async (tx) => {
      const claimed = await tx.appointment.updateMany({
        where: {
          id: input.appointmentId,
          status: APPOINTMENT_STATUS.RECORD_SUBMITTED,
        },
        // 状态保持不变（R37）：写同值只为拿到「仍在 3 态」的原子判定
        data: { status: APPOINTMENT_STATUS.RECORD_SUBMITTED },
      });
      if (claimed.count === 0) {
        return { kind: 'transition-invalid' } as const;
      }

      const updated = await tx.guidanceRecord.updateMany({
        where: { appointmentId: input.appointmentId },
        data: {
          actualTime: input.actualTime,
          mode: input.mode,
          coreContent: input.coreContent,
          followUp: input.followUp,
          durationMinutes: input.durationMinutes,
          submittedBy: input.submittedBy,
          submittedAt: input.submittedAt,
        },
      });
      if (updated.count === 0) {
        return { kind: 'transition-invalid' } as const;
      }

      const record = await tx.guidanceRecord.findFirst({
        where: { appointmentId: input.appointmentId },
        include: {
          appointment: {
            include: { student: { include: { orgUnit: true } } },
          },
        },
      });
      if (record === null) {
        return { kind: 'transition-invalid' } as const;
      }
      return { kind: 'updated', record } as const;
    });
  }

  /**
   * **超时扫描：`0 PENDING`**（Task 25 / R17）：把 `createdAt < cutoff` 的
   * `0 PENDING` 批量推进到 `9 EXPIRED`，返回命中行数。
   *
   * 一条 `UPDATE … WHERE status = 0 AND created_at < cutoff` 完成判定与写入：
   * - **只扫 PENDING**——`1 CONFIRMED` 及之后由各自规则处理（`1` 见
   *   {@link expireConfirmedBefore}；`2` 只是语义态，R19）；
   * - **幂等**——第二次跑时已经没有 `status = 0` 的旧行，`count = 0`；
   * - 不逐行读再写，也没有裸 SQL（LAYER-09）；审计列由 Prisma 扩展统一刷新
   *   （无请求上下文时写 `SYSTEM_USER_ID`，DB-04）。
   */
  async expirePendingBefore(cutoff: Date): Promise<number> {
    const updated = await this.prisma.client.appointment.updateMany({
      where: { status: APPOINTMENT_STATUS.PENDING, createdAt: { lt: cutoff } },
      data: { status: APPOINTMENT_STATUS.EXPIRED },
    });
    return updated.count;
  }

  /**
   * **超时扫描：`1 CONFIRMED`**（Task 25b / R12 + R38）：把
   * `requestedTime < cutoff` 的 `1 CONFIRMED` 批量推进到 `9 EXPIRED`，返回命中行数。
   *
   * 基准是**约定时间 `requestedTime`**，不是 `createdAt`——确认动作可能发生在
   * 预约创建很久之后，按创建时间判会误伤「刚确认、约定时间还没到」的预约。
   *
   * 一条 `UPDATE … WHERE status = 1 AND requested_time < cutoff` 完成判定与写入：
   * - **只扫 CONFIRMED**——`0` 走 {@link expirePendingBefore}，`3/4/5/6` 一律不动；
   * - **幂等**——第二次跑时已经没有 `status = 1` 的过期行，`count = 0`；
   * - 不逐行读再写，也没有裸 SQL（LAYER-09）；审计列由 Prisma 扩展统一刷新
   *   （无请求上下文时写 `SYSTEM_USER_ID`，DB-04）。
   */
  async expireConfirmedBefore(cutoff: Date): Promise<number> {
    const updated = await this.prisma.client.appointment.updateMany({
      where: {
        status: APPOINTMENT_STATUS.CONFIRMED,
        requestedTime: { lt: cutoff },
      },
      data: { status: APPOINTMENT_STATUS.EXPIRED },
    });
    return updated.count;
  }

  /**
   * **超时扫描：`4 STUDENT_CONFIRMED`**（P3 Task 34 / R52）：把
   * `updatedAt < cutoff` 的 `4 STUDENT_CONFIRMED` 批量推进到 `6 COMPLETED`，返回命中行数。
   *
   * 这条不是「惩罚」而是「关窗」：评价只在 `4` 上可写（R43），学生长期不评价的话
   * 预约会永久停在 `4`——§5.3 的「指导完成率」与 §5.2 的工作量统计都会失真。
   * 推进到 `6` 之后评价窗口关闭，**本方法不写评价**。
   *
   * 基准是 `updatedAt`（最后一次进入 `4` 的那次写入），不是 `requestedTime`：
   * 学生确认记录的时刻才是「该评价了」的起点。
   *
   * - **只扫 `4`**——`0` / `1` 各有自己的分支，`3` / `5` / `6` 一律不动；
   * - **幂等**——第二次跑时已经没有 `status = 4` 的旧行，`count = 0`；
   * - 不逐行读再写，也没有裸 SQL（LAYER-09）。
   */
  async expireStudentConfirmedBefore(cutoff: Date): Promise<number> {
    const updated = await this.prisma.client.appointment.updateMany({
      where: {
        status: APPOINTMENT_STATUS.STUDENT_CONFIRMED,
        updatedAt: { lt: cutoff },
      },
      data: { status: APPOINTMENT_STATUS.COMPLETED },
    });
    return updated.count;
  }

  // ── 材料（Task 29）─────────────────────────────────────────────────

  /**
   * 按主键取一条**未软删**的预约，并带出申请人 + 申请人部门投影（GET 材料的
   * 可见性判定用）。已软删与不存在同判 null，调用方统一 404 / 32001。
   */
  async findWithStudentById(
    id: bigint,
  ): Promise<AppointmentWithStudent | null> {
    return this.prisma.client.appointment.findFirst({
      where: { id },
      include: { student: { include: { orgUnit: true } } },
    });
  }

  // ── 列表与详情（Task 30）───────────────────────────────────────────

  /**
   * `GET /appointments` 的一页 + **过滤后的总数**。
   *
   * 分页是 `skip` / `take` + 独立 `count`（brief 红线 5），不是把全表读进内存
   * 再切片——后者在数据量上来之后是 O(全表) 的内存与网络开销。
   * 排序 `createdAt DESC, id DESC`：同一毫秒创建的两条按 id 兜底，翻页才稳定。
   */
  async findPage(params: {
    status?: number;
    type?: number;
    filter: AppointmentListFilter;
    page: number;
    pageSize: number;
  }): Promise<{ rows: AppointmentWithParties[]; total: number }> {
    const where = buildAppointmentListWhere(params);

    const [total, rows] = await Promise.all([
      this.prisma.client.appointment.count({ where }),
      this.prisma.client.appointment.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: APPOINTMENT_PARTIES_INCLUDE,
      }),
    ]);

    return { rows, total };
  }

  /**
   * `GET /appointments/:id` 的单条载入：预约 + 申请人 + 导师（含各自组织）。
   * 已软删与不存在同判 null，调用方统一 404 / 32001。
   */
  async findDetailById(id: bigint): Promise<AppointmentWithParties | null> {
    return this.prisma.client.appointment.findFirst({
      where: { id },
      include: APPOINTMENT_PARTIES_INCLUDE,
    });
  }

  /** 按预约取唯一一条**未软删**的指导记录行（只取业务列，不联查学生） */
  async findRecordRowByAppointmentId(
    appointmentId: bigint,
  ): Promise<GuidanceRecord | null> {
    return this.prisma.client.guidanceRecord.findFirst({
      where: { appointmentId },
    });
  }

  /** 某预约的全部**未软删**预约材料（id 升序）。软删行由读过滤天然滤掉 */
  async findAppointmentMaterials(
    appointmentId: bigint,
  ): Promise<AppointmentMaterial[]> {
    return this.prisma.client.appointmentMaterial.findMany({
      where: { appointmentId },
      orderBy: [{ id: 'asc' }],
    });
  }

  /** 某条指导记录的全部**未软删**过程材料（id 升序） */
  async findGuidanceMaterials(recordId: bigint): Promise<GuidanceMaterial[]> {
    return this.prisma.client.guidanceMaterial.findMany({
      where: { recordId },
      orderBy: [{ id: 'asc' }],
    });
  }

  /**
   * 导师维度的指导记录列表 / 导出。按 appointment.mentorProfileId 过滤，
   * 时间锚点是记录的实际指导时间 actualTime（不是预约的 requestedTime）。
   */
  async findMentorGuidanceRecords(
    mentorProfileId: bigint,
    filter: {
      from?: Date;
      to?: Date;
      type?: number;
      skip: number;
      take: number;
    },
  ): Promise<{
    rows: Array<
      GuidanceRecord & {
        appointment: Appointment & { student: SyncPerson };
      }
    >;
    total: number;
  }> {
    const where: Prisma.GuidanceRecordWhereInput = {
      deletedAt: null,
      appointment: {
        mentorProfileId,
        deletedAt: null,
        ...(filter.type === undefined ? {} : { type: filter.type }),
      },
      ...(filter.from === undefined && filter.to === undefined
        ? {}
        : {
            actualTime: {
              ...(filter.from === undefined ? {} : { gte: filter.from }),
              ...(filter.to === undefined ? {} : { lte: filter.to }),
            },
          }),
    };

    const [total, rows] = await Promise.all([
      this.prisma.client.guidanceRecord.count({ where }),
      this.prisma.client.guidanceRecord.findMany({
        where,
        include: {
          appointment: { include: { student: true } },
        },
        orderBy: [{ actualTime: 'desc' }, { id: 'desc' }],
        skip: filter.skip,
        take: filter.take,
      }),
    ]);
    return { rows, total };
  }

  /**
   * `:materialId` 必须**同时**命中 `{ id, appointmentId }`——挂在别的预约下的
   * 材料不算本预约的（调用方 404 / 32005，不暴露「这条材料确实存在」）。
   */
  async findAppointmentMaterialById(
    appointmentId: bigint,
    id: bigint,
  ): Promise<AppointmentMaterial | null> {
    return this.prisma.client.appointmentMaterial.findFirst({
      where: { id, appointmentId },
    });
  }

  /** 过程材料 `:materialId` 必须**同时**命中 `{ id, recordId }`（调用方 404 / 33002） */
  async findGuidanceMaterialById(
    recordId: bigint,
    id: bigint,
  ): Promise<GuidanceMaterial | null> {
    return this.prisma.client.guidanceMaterial.findFirst({
      where: { id, recordId },
    });
  }

  /**
   * 重复挂检查：同一 `fileId` 在本预约下已有**未删**预约材料。
   * 「唯一性按未删行算」靠读过滤天然成立——摘掉（软删）之后同一 fileId 允许再挂。
   *
   * 这是**预检**（更早、更便宜的错误）；并发双发仍可能双双查到 0 行，由 DB 的
   * 生成列唯一键 `uk_appointment_material_file_active` 兜底（P2002 → 409 / 32006）。
   */
  async hasActiveAppointmentMaterial(
    appointmentId: bigint,
    fileId: bigint,
  ): Promise<boolean> {
    const count = await this.prisma.client.appointmentMaterial.count({
      where: { appointmentId, fileId },
    });
    return count > 0;
  }

  /** 重复挂检查：同一 `fileId` 在本条记录下已有**未删**过程材料 */
  async hasActiveGuidanceMaterial(
    recordId: bigint,
    fileId: bigint,
  ): Promise<boolean> {
    const count = await this.prisma.client.guidanceMaterial.count({
      where: { recordId, fileId },
    });
    return count > 0;
  }

  /** 挂一条预约材料。createdBy / updatedBy 是类型占位，扩展按当前操作者重写（DB-05） */
  async createAppointmentMaterial(data: {
    appointmentId: bigint;
    fileId: bigint;
    kind: number;
  }): Promise<AppointmentMaterial> {
    return this.prisma.client.appointmentMaterial.create({
      data: {
        appointmentId: data.appointmentId,
        fileId: data.fileId,
        kind: data.kind,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
  }

  /** 挂一条过程材料（同上，审计列是占位） */
  async createGuidanceMaterial(data: {
    recordId: bigint;
    fileId: bigint;
  }): Promise<GuidanceMaterial> {
    return this.prisma.client.guidanceMaterial.create({
      data: {
        recordId: data.recordId,
        fileId: data.fileId,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
  }

  /**
   * 摘预约材料 = 软删：显式 `update` 打 `deletedAt` / `deletedBy`（R24：扩展
   * 拒 delete，软删写在 repository 是唯一合法形态）。**不动 `SysFile`**：文件行
   * 还在，同一 fileId 允许再挂。
   */
  async softDeleteAppointmentMaterial(id: bigint): Promise<void> {
    await this.prisma.client.appointmentMaterial.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: currentActorId() },
    });
  }

  /** 摘过程材料 = 软删（同上，不动 `SysFile`） */
  async softDeleteGuidanceMaterial(id: bigint): Promise<void> {
    await this.prisma.client.guidanceMaterial.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: currentActorId() },
    });
  }

  /**
   * 材料行引用的文件元数据（文件名 / 大小 / MIME 展示用）。**只读** `SysFile`
   * ——材料的创建与删除都走 FileModule 的接口，本模块不写 `SysFile` 的任何列。
   * 走 client（滤软删行）：文件被删后列表兜底空元数据（mapper），不冒充文件名。
   */
  async findFilesByIds(ids: readonly bigint[]): Promise<SysFile[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.prisma.client.sysFile.findMany({
      where: { id: { in: [...ids] } },
    });
  }
}

/** 开放时段状态导出，供 Service 判 `status = 0` 关闭 */
export { SLOT_OPEN_STATUS };
