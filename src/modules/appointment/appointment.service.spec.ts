import { HttpStatus } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type {
  Appointment,
  MentorProfile,
  MentorTimeSlot,
  SyncPerson,
} from '@prisma/client';
import { ErrorCode } from '../../common/constants/error-code';
import {
  isDeptInFilter,
  type DataScopeFilter,
} from '../../common/constants/data-scope';
import type { RequestUser } from '../../common/context/request-context';
import { BusinessException } from '../../common/errors/business.exception';
import type { AppConfig } from '../../config/configuration';
import type { ConfigService as SysConfigService } from '../config/config.service';
import type { DataScopeService } from '../data-scope/data-scope.service';
import type { FileService } from '../file/file.service';
import type { UserService } from '../user/user.service';
import { AppointmentService } from './appointment.service';
import type {
  AppointmentCreateInput,
  AppointmentCreateResult,
  AppointmentRepository,
  GuidanceRecordSubmitResult,
  GuidanceRecordWithStudent,
} from './appointment.repository';
import type { CreateAppointmentDto } from './dto/create-appointment.dto';
import type { ConfirmAppointmentDto } from './dto/confirm-appointment.dto';
import type { RejectAppointmentDto } from './dto/reject-appointment.dto';
import type { RescheduleAppointmentDto } from './dto/reschedule-appointment.dto';
import type { DisputeAppointmentDto } from './dto/dispute-appointment.dto';
import type { AdjudicateAppointmentDto } from './dto/adjudicate-appointment.dto';
import type { SubmitGuidanceRecordDto } from './dto/submit-guidance-record.dto';

/**
 * 2026-11-02 是周一，`02:00Z` = **北京时间 10:00**（R31 之后时段按墙钟时间算），
 * 落在 `[09:00, 11:00)` 内。
 */
const MONDAY_10 = new Date('2026-11-02T02:00:00.000Z');

function personRow(overrides: Partial<SyncPerson> = {}): SyncPerson {
  return {
    id: 7n,
    login: 'S001',
    realName: '陈一鸣',
    personType: 'student',
    orgUnitId: 3n,
    major: null,
    className: null,
    mobile: null,
    syncedAt: new Date('2026-10-27T00:00:00.000Z'),
    syncRunId: null,
    createdAt: new Date('2026-10-27T00:00:00.000Z'),
    updatedAt: new Date('2026-10-27T00:00:00.000Z'),
    createdBy: 0n,
    updatedBy: 0n,
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  };
}

function profileRow(overrides: Partial<MentorProfile> = {}): MentorProfile {
  return {
    id: 5n,
    personId: 9n,
    researchFields: [],
    status: 2,
    summary: null,
    researchAchievements: null,
    guidanceExperience: null,
    affiliateOrg: null,
    socialRoles: null,
    professionalTitle: null,
    createdAt: new Date('2026-10-20T00:00:00.000Z'),
    updatedAt: new Date('2026-10-20T00:00:00.000Z'),
    createdBy: 0n,
    updatedBy: 0n,
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  };
}

function slotRow(overrides: Partial<MentorTimeSlot> = {}): MentorTimeSlot {
  return {
    id: 11n,
    mentorProfileId: 5n,
    weekday: 1,
    startTime: '09:00',
    endTime: '11:00',
    status: 1,
    createdAt: new Date('2026-10-29T01:00:00.000Z'),
    updatedAt: new Date('2026-10-29T01:00:00.000Z'),
    createdBy: 1n,
    updatedBy: 1n,
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  };
}

function appointmentRow(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: 21n,
    studentPersonId: 7n,
    mentorProfileId: 5n,
    type: 1,
    status: 0,
    requestedTime: MONDAY_10,
    proposedTime: null,
    topic: '挑战杯选题',
    questions: '如何选题？',
    mode: 1,
    handleComment: null,
    rejectReason: null,
    disputeReason: null,
    adjudicateComment: null,
    slotId: 11n,
    createdAt: new Date('2026-10-30T00:00:00.000Z'),
    updatedAt: new Date('2026-10-30T00:00:00.000Z'),
    createdBy: 7n,
    updatedBy: 7n,
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  };
}

/** 指导记录 + 所属预约 + 申请人（R27 的响应形状所需的最小结构） */
function recordRow(
  overrides: Partial<GuidanceRecordWithStudent> = {},
): GuidanceRecordWithStudent {
  return {
    id: 31n,
    appointmentId: 21n,
    actualTime: new Date('2026-10-29T02:00:00.000Z'),
    mode: 1,
    coreContent: '核心指导内容',
    followUp: '后续指导建议',
    submittedBy: 9n,
    submittedAt: new Date('2026-10-29T03:00:00.000Z'),
    // P3 Task 35 / R58：存量记录的时长为 0（「未填」）
    durationMinutes: 0,
    createdAt: new Date('2026-10-29T03:00:00.000Z'),
    updatedAt: new Date('2026-10-29T03:00:00.000Z'),
    createdBy: 9n,
    updatedBy: 9n,
    deletedAt: null,
    deletedBy: null,
    appointment: {
      ...appointmentRow({ status: 3 }),
      student: { ...personRow(), orgUnit: null },
    },
    ...overrides,
  };
}

function caller(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    userId: 1n,
    username: 'S001',
    isSuperAdmin: false,
    accessJti: 'jti-test',
    accessExpiresAt: 1893456000,
    ...overrides,
  };
}

function createDto(
  overrides: Partial<CreateAppointmentDto> = {},
): CreateAppointmentDto {
  return {
    mentorProfileId: '5',
    type: 1,
    slotId: '11',
    requestedTime: MONDAY_10.toISOString(),
    topic: '挑战杯选题',
    questions: '如何选题？',
    mode: 1,
    ...overrides,
  };
}

interface Harness {
  service: AppointmentService;
  findPersonByLogin: jest.Mock;
  findApprovedMentorById: jest.Mock;
  findOwnedSlotById: jest.Mock;
  createWithSlotLock: jest.Mock;
  findProfileByPersonId: jest.Mock;
  findById: jest.Mock;
  updateIfPending: jest.Mock;
  updateIfCancellable: jest.Mock;
  updateIfRecordSubmitted: jest.Mock;
  updateIfDisputed: jest.Mock;
  findStudentOrgDeptId: jest.Mock;
  createRecordWithTransition: jest.Mock;
  updateRecordWithTransition: jest.Mock;
  assertDeptVisible: jest.Mock;
  expirePendingBefore: jest.Mock;
  expireConfirmedBefore: jest.Mock;
  expireStudentConfirmedBefore: jest.Mock;
  sysConfigGetNumber: jest.Mock;
  userFindById: jest.Mock;
  resolveScope: jest.Mock;
}

function buildService(
  options: {
    personRow?: SyncPerson | null;
    profileRow?: MentorProfile | null;
    slotRow?: MentorTimeSlot | null;
    createResult?: AppointmentCreateResult;
    /** 处理侧：身份链解析出的调用者导师档案（null = 调用者不是导师） */
    callerProfileRow?: MentorProfile | null;
    /** 处理侧：`findById` 返回的预约（null = 不存在 / 已软删） */
    appointmentRow?: Appointment | null;
    /**
     * 处理侧：`updateIfPending` 的返回值。`null` = 条件更新没命中（`status`
     * 已不是 `0 PENDING`，即并发里输掉的一方）→ 409 / 32003。
     */
    updateResult?: Appointment | null;
    /**
     * 取消侧：`updateIfCancellable` 的返回值。`null` = 条件更新没命中
     * （状态已不在可取消集合里）→ 409 / 32003。
     */
    cancelUpdateResult?: Appointment | null;
    /**
     * 学生确认记录 / 提异议侧：`updateIfRecordSubmitted` 的返回值。`null` =
     * 条件更新没命中（`status` 已不是 `3 RECORD_SUBMITTED`）→ 409 / 32003。
     */
    recordActionUpdateResult?: Appointment | null;
    /**
     * 异议复核侧：`updateIfDisputed` 的返回值。`null` = 条件更新没命中
     * （`status` 已不是 `5 DISPUTED`，即并发里输掉的一方）→ 409 / 32003。
     */
    disputedUpdateResult?: Appointment | null;
    /** 异议复核侧：`findStudentOrgDeptId` 返回的申请人部门（null = 无投影） */
    studentDeptId?: bigint | null;
    /** 异议复核侧：`resolve` 返回的数据范围（默认 `self`） */
    scope?: DataScopeFilter;
    /** 异议复核侧：调用者 `SysUser.deptId`（默认 null） */
    userDeptId?: bigint | null;
    /** 记录填报 / 重填：repository 的落库结果（默认 created） */
    recordSubmitResult?: GuidanceRecordSubmitResult;
    /** 超时扫描：`expirePendingBefore` 返回的命中行数 */
    expireCount?: number;
    /** 超时扫描：`expireConfirmedBefore` 返回的命中行数 */
    confirmedCount?: number;
    /** 超时扫描：`expireStudentConfirmedBefore` 返回的命中行数（P3 R52） */
    studentConfirmedCount?: number;
    /** 超时扫描：`SysConfigService.getNumber` 返回的 TTL（小时） */
    ttlHours?: number;
    /** 超时扫描：`SysConfigService.getNumber` 返回的已确认宽限期（小时） */
    graceHours?: number;
    /** 超时扫描：`SysConfigService.getNumber` 返回的评价窗口（天，P3 R52） */
    reviewDays?: number;
    /** 'self' 天花板绊线不过（有人把 @DataScope('self') 改宽了） */
    tripwire?: boolean;
  } = {},
): Harness {
  const findPersonByLogin = jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        options.personRow === undefined ? personRow() : options.personRow,
      ),
    );
  const findApprovedMentorById = jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        options.profileRow === undefined ? profileRow() : options.profileRow,
      ),
    );
  const findOwnedSlotById = jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        options.slotRow === undefined ? slotRow() : options.slotRow,
      ),
    );
  const createWithSlotLock = jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        options.createResult === undefined
          ? { kind: 'created', appointment: appointmentRow() }
          : options.createResult,
      ),
    );
  const findProfileByPersonId = jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        options.callerProfileRow === undefined
          ? profileRow()
          : options.callerProfileRow,
      ),
    );
  const findById = jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        options.appointmentRow === undefined
          ? appointmentRow()
          : options.appointmentRow,
      ),
    );
  const updateIfPending = jest
    .fn()
    .mockImplementation((id: bigint, data: Partial<Appointment>) =>
      Promise.resolve(
        options.updateResult === undefined
          ? appointmentRow({ id, ...data })
          : options.updateResult,
      ),
    );
  const updateIfCancellable = jest
    .fn()
    .mockImplementation((id: bigint) =>
      Promise.resolve(
        options.cancelUpdateResult === undefined
          ? appointmentRow({ id, status: 8 })
          : options.cancelUpdateResult,
      ),
    );
  const updateIfRecordSubmitted = jest
    .fn()
    .mockImplementation((id: bigint, data: Partial<Appointment>) =>
      Promise.resolve(
        options.recordActionUpdateResult === undefined
          ? appointmentRow({ id, ...data })
          : options.recordActionUpdateResult,
      ),
    );
  const expirePendingBefore = jest
    .fn()
    .mockImplementation(() => Promise.resolve(options.expireCount ?? 0));
  const expireConfirmedBefore = jest
    .fn()
    .mockImplementation(() => Promise.resolve(options.confirmedCount ?? 0));
  const expireStudentConfirmedBefore = jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve(options.studentConfirmedCount ?? 0),
    );
  const updateIfDisputed = jest
    .fn()
    .mockImplementation((id: bigint, data: Partial<Appointment>) =>
      Promise.resolve(
        options.disputedUpdateResult === undefined
          ? appointmentRow({ id, ...data })
          : options.disputedUpdateResult,
      ),
    );
  const findStudentOrgDeptId = jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        options.studentDeptId === undefined ? null : options.studentDeptId,
      ),
    );
  const createRecordWithTransition = jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        options.recordSubmitResult ?? { kind: 'created', record: recordRow() },
      ),
    );
  const updateRecordWithTransition = jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        options.recordSubmitResult ?? { kind: 'updated', record: recordRow() },
      ),
    );
  const assertDeptVisible = jest
    .fn()
    .mockImplementation((filter: DataScopeFilter, deptId: bigint) => {
      if (!isDeptInFilter(filter, deptId)) {
        throw new BusinessException(
          ErrorCode.FORBIDDEN,
          '无权限',
          HttpStatus.FORBIDDEN,
        );
      }
    });
  const sysConfigGetNumber = jest
    .fn()
    .mockImplementation((code: string, defaultValue: number) => {
      if (code === 'appointment.confirmed_grace_hours') {
        return Promise.resolve(options.graceHours ?? defaultValue);
      }
      if (code === 'appointment.review_ttl_days') {
        return Promise.resolve(options.reviewDays ?? defaultValue);
      }
      return Promise.resolve(options.ttlHours ?? defaultValue);
    });
  const userFindById = jest.fn().mockImplementation(() =>
    Promise.resolve({
      username: 'S001',
      deptId: options.userDeptId ?? null,
    }),
  );
  const resolveScope = jest
    .fn()
    .mockImplementation((): Promise<DataScopeFilter> =>
      Promise.resolve(
        options.tripwire === true
          ? { kind: 'all' }
          : (options.scope ?? { kind: 'self', userId: 1n }),
      ),
    );

  const service = new AppointmentService(
    {
      findPersonByLogin,
      findApprovedMentorById,
      findOwnedSlotById,
      createWithSlotLock,
      findProfileByPersonId,
      findById,
      updateIfPending,
      updateIfCancellable,
      updateIfRecordSubmitted,
      updateIfDisputed,
      findStudentOrgDeptId,
      createRecordWithTransition,
      updateRecordWithTransition,
      expirePendingBefore,
      expireConfirmedBefore,
      expireStudentConfirmedBefore,
    } as unknown as AppointmentRepository,
    { findById: userFindById } as unknown as UserService,
    { resolve: resolveScope, assertDeptVisible } as unknown as DataScopeService,
    { getNumber: sysConfigGetNumber } as unknown as SysConfigService,
    { assertOwnedBy: jest.fn(), serve: jest.fn() } as unknown as FileService,
    // 业务时区固定 Asia/Shanghai：下面所有时刻都按北京时间构造（R31）
    {
      getOrThrow: () => 'Asia/Shanghai',
    } as unknown as ConfigService<AppConfig, true>,
  );

  return {
    service,
    findPersonByLogin,
    findApprovedMentorById,
    findOwnedSlotById,
    createWithSlotLock,
    findProfileByPersonId,
    findById,
    updateIfPending,
    updateIfCancellable,
    updateIfRecordSubmitted,
    updateIfDisputed,
    findStudentOrgDeptId,
    createRecordWithTransition,
    updateRecordWithTransition,
    assertDeptVisible,
    expirePendingBefore,
    expireConfirmedBefore,
    expireStudentConfirmedBefore,
    sysConfigGetNumber,
    userFindById,
    resolveScope,
  };
}

async function captureError(
  promise: Promise<unknown>,
): Promise<BusinessException> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BusinessException);
  return error as BusinessException;
}

describe('AppointmentService 守卫 1：调用者必须是学生', () => {
  it("'self' 天花板绊线不过 → 403 / 10003，一个查询都不发", async () => {
    const h = buildService({ tripwire: true });
    const error = await captureError(h.service.create(createDto(), caller()));

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.FORBIDDEN,
      message: '无权限',
    });
    expect(h.userFindById).not.toHaveBeenCalled();
    expect(h.findApprovedMentorById).not.toHaveBeenCalled();
  });

  it('无 SyncPerson → 403 / 10003「只有学生可以发起预约」', async () => {
    const h = buildService({ personRow: null });
    const error = await captureError(h.service.create(createDto(), caller()));

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.FORBIDDEN,
      message: '只有学生可以发起预约',
    });
    expect(h.findApprovedMentorById).not.toHaveBeenCalled();
  });

  it('personType != student（导师）→ 403 / 10003，不查导师档案', async () => {
    const h = buildService({
      personRow: personRow({ personType: 'internalMentor' }),
    });
    const error = await captureError(h.service.create(createDto(), caller()));

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.FORBIDDEN,
      message: '只有学生可以发起预约',
    });
    expect(h.findApprovedMentorById).not.toHaveBeenCalled();
  });

  it('身份链：userId → username → login', async () => {
    const h = buildService();
    await h.service.create(createDto(), caller());

    expect(h.userFindById).toHaveBeenCalledWith(1n);
    expect(h.findPersonByLogin).toHaveBeenCalledWith('S001');
  });
});

describe('AppointmentService 守卫 2：导师档案', () => {
  it('档案不存在 / 未生效 / 人员已离场 → 404 / 31102，不查时段', async () => {
    const h = buildService({ profileRow: null });
    const error = await captureError(h.service.create(createDto(), caller()));

    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_PROFILE_NOT_FOUND,
      message: '导师专业档案不存在',
    });
    expect(h.findApprovedMentorById).toHaveBeenCalledWith(5n);
    expect(h.findOwnedSlotById).not.toHaveBeenCalled();
  });
});

describe('AppointmentService 守卫 3 / 4：时段', () => {
  it('时段不存在 / 不属于该导师 → 409 / 31202', async () => {
    const h = buildService({ slotRow: null });
    const error = await captureError(h.service.create(createDto(), caller()));

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_SLOT_UNAVAILABLE,
      message: '可指导时段不可用',
    });
    expect(h.createWithSlotLock).not.toHaveBeenCalled();
  });

  it('时段已关闭（status=0）→ 409 / 31202', async () => {
    const h = buildService({ slotRow: slotRow({ status: 0 }) });
    const error = await captureError(h.service.create(createDto(), caller()));

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_SLOT_UNAVAILABLE,
    });
    expect(h.createWithSlotLock).not.toHaveBeenCalled();
  });

  it('weekday 与时段不符 → 409 / 31202', async () => {
    const h = buildService({ slotRow: slotRow({ weekday: 2 }) });
    const error = await captureError(h.service.create(createDto(), caller()));

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_SLOT_UNAVAILABLE,
    });
    expect(h.createWithSlotLock).not.toHaveBeenCalled();
  });

  it('时刻不在 [startTime, endTime) → 409 / 31202（10:00 对 11:00-12:00）', async () => {
    const h = buildService({
      slotRow: slotRow({ startTime: '11:00', endTime: '12:00' }),
    });
    const error = await captureError(h.service.create(createDto(), caller()));

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_SLOT_UNAVAILABLE,
    });
    expect(h.createWithSlotLock).not.toHaveBeenCalled();
  });

  it('半开区间下界包含：[09:00, 11:00) 命中北京时间 09:00（01:00Z）', async () => {
    const h = buildService();
    const dto = createDto({
      requestedTime: '2026-11-02T01:00:00.000Z',
    });
    await h.service.create(dto, caller());

    expect(h.createWithSlotLock).toHaveBeenCalledTimes(1);
  });

  it('R31：同一 UTC 时刻的「周一 17:00 北京时间」不命中 → 409 / 31202', async () => {
    // 09:00Z 在 UTC 口径下正好落在 [09:00, 11:00)；按墙钟时间算是北京 17:00，
    // 必须拒绝。这条钉死「按 UTC 比较」这个错误。
    const h = buildService();
    const dto = createDto({
      requestedTime: '2026-11-02T09:00:00.000Z',
    });
    const error = await captureError(h.service.create(dto, caller()));

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_SLOT_UNAVAILABLE,
    });
    expect(h.createWithSlotLock).not.toHaveBeenCalled();
  });
});

describe('AppointmentService 守卫 5 / 6：并发守卫的落库结果', () => {
  it('同一时段已被占用 → 409 / 32004', async () => {
    const h = buildService({ createResult: { kind: 'slot-conflict' } });
    const error = await captureError(h.service.create(createDto(), caller()));

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.APPOINTMENT_SLOT_CONFLICT,
      message: '该时段已被预约占用',
    });
  });

  it('同学生同导师已有未终态预约 → 409 / 32003', async () => {
    const h = buildService({ createResult: { kind: 'student-conflict' } });
    const error = await captureError(h.service.create(createDto(), caller()));

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.APPOINTMENT_TRANSITION_INVALID,
      message: '已有未完成的预约，不能重复发起',
    });
  });
});

describe('AppointmentService 正例', () => {
  it('落库入参：studentPersonId 取调用者、其余字段原样（不透传 DTO 的 id 字符串）', async () => {
    const h = buildService();
    await h.service.create(createDto({ type: 3, mode: 2 }), caller());

    const calls = h.createWithSlotLock.mock.calls as unknown as Array<
      [AppointmentCreateInput]
    >;
    const input = calls[0][0];
    expect(input).toEqual({
      studentPersonId: 7n,
      mentorProfileId: 5n,
      type: 3,
      requestedTime: MONDAY_10,
      topic: '挑战杯选题',
      questions: '如何选题？',
      mode: 2,
      slotId: 11n,
    });
  });

  it('响应为显式映射（BIGINT / 时间转字符串，可空字段为 null）', async () => {
    const h = buildService();
    const result = await h.service.create(createDto(), caller());

    expect(result).toEqual({
      id: '21',
      studentPersonId: '7',
      mentorProfileId: '5',
      type: 1,
      status: 0,
      requestedTime: '2026-11-02T02:00:00.000Z',
      proposedTime: null,
      topic: '挑战杯选题',
      questions: '如何选题？',
      mode: 1,
      handleComment: null,
      rejectReason: null,
      disputeReason: null,
      adjudicateComment: null,
      slotId: '11',
    });
  });
});

// ── Task 24：预约处理（confirm / reject / reschedule）────────────────

function confirmDto(
  overrides: Partial<ConfirmAppointmentDto> = {},
): ConfirmAppointmentDto {
  return { ...overrides };
}

function rejectDto(
  overrides: Partial<RejectAppointmentDto> = {},
): RejectAppointmentDto {
  return { reason: '该时段已排满，请另约时间', ...overrides };
}

function rescheduleDto(
  overrides: Partial<RescheduleAppointmentDto> = {},
): RescheduleAppointmentDto {
  return { proposedTime: '2026-11-03T02:00:00.000Z', ...overrides };
}

describe('AppointmentService 处理守卫链：404 → 403 → 409', () => {
  it('天花板绊线不过 → 403 / 10003，一个查询都不发', async () => {
    const h = buildService({ tripwire: true });
    const error = await captureError(
      h.service.confirm(21n, confirmDto(), caller()),
    );

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.FORBIDDEN,
      message: '无权限',
    });
    expect(h.findById).not.toHaveBeenCalled();
    expect(h.updateIfPending).not.toHaveBeenCalled();
  });

  it('预约不存在 / 已软删 → 404 / 32001，不解析身份、不落库', async () => {
    const h = buildService({ appointmentRow: null });
    const error = await captureError(
      h.service.confirm(999999n, confirmDto(), caller()),
    );

    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.APPOINTMENT_NOT_FOUND,
      message: '预约不存在',
    });
    expect(h.findProfileByPersonId).not.toHaveBeenCalled();
    expect(h.updateIfPending).not.toHaveBeenCalled();
  });

  it('别的导师（档案 id 不符）→ 403 / 32002，不落库', async () => {
    const h = buildService({ callerProfileRow: profileRow({ id: 6n }) });
    const error = await captureError(
      h.service.confirm(21n, confirmDto(), caller()),
    );

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.APPOINTMENT_FORBIDDEN,
      message: '无权访问该预约',
    });
    expect(h.updateIfPending).not.toHaveBeenCalled();
  });

  it('调用者不是导师（无档案）→ 403 / 32002（不是 404）', async () => {
    const h = buildService({ callerProfileRow: null });
    const error = await captureError(
      h.service.confirm(21n, confirmDto(), caller()),
    );

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.APPOINTMENT_FORBIDDEN,
    });
    expect(h.updateIfPending).not.toHaveBeenCalled();
  });

  it('status != 0（已确认 / 已拒绝）→ 409 / 32003，不落库', async () => {
    for (const status of [1, 7]) {
      const h = buildService({ appointmentRow: appointmentRow({ status }) });
      const error = await captureError(
        h.service.confirm(21n, confirmDto(), caller()),
      );

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({
        code: ErrorCode.APPOINTMENT_TRANSITION_INVALID,
        message: '当前状态不允许该操作',
      });
      expect(h.updateIfPending).not.toHaveBeenCalled();
    }
  });

  it('身份链：userId → username → login → personId → MentorProfile', async () => {
    const h = buildService();
    await h.service.confirm(21n, confirmDto(), caller());

    expect(h.userFindById).toHaveBeenCalledWith(1n);
    expect(h.findPersonByLogin).toHaveBeenCalledWith('S001');
    expect(h.findProfileByPersonId).toHaveBeenCalledWith(7n);
  });
});

describe('AppointmentService confirm', () => {
  it('落库：status 1 + handleComment，响应为显式映射', async () => {
    const h = buildService();
    const result = await h.service.confirm(
      21n,
      confirmDto({ comment: '时间没问题' }),
      caller(),
    );

    expect(h.updateIfPending).toHaveBeenCalledWith(21n, {
      status: 1,
      handleComment: '时间没问题',
    });
    expect(result.status).toBe(1);
    expect(result.handleComment).toBe('时间没问题');
  });

  it('不传 comment → handleComment 落 null', async () => {
    const h = buildService();
    const result = await h.service.confirm(21n, confirmDto(), caller());

    expect(h.updateIfPending).toHaveBeenCalledWith(21n, {
      status: 1,
      handleComment: null,
    });
    expect(result.handleComment).toBeNull();
  });
});

describe('AppointmentService reject', () => {
  it('落库：status 7 + rejectReason', async () => {
    const h = buildService();
    const result = await h.service.reject(
      21n,
      rejectDto({ reason: '时间冲突' }),
      caller(),
    );

    expect(h.updateIfPending).toHaveBeenCalledWith(21n, {
      status: 7,
      rejectReason: '时间冲突',
    });
    expect(result.status).toBe(7);
    expect(result.rejectReason).toBe('时间冲突');
  });
});

describe('AppointmentService reschedule', () => {
  it('留在 status 0：只写 proposedTime + handleComment，requestedTime 不动（R13）', async () => {
    const h = buildService();
    const proposed = new Date('2026-11-03T02:00:00.000Z');
    const result = await h.service.reschedule(
      21n,
      rescheduleDto({
        proposedTime: proposed.toISOString(),
        comment: '改到周二上午',
      }),
      caller(),
    );

    // 落库参数**恰好**这两列：没有 status、没有 requestedTime
    expect(h.updateIfPending).toHaveBeenCalledWith(21n, {
      proposedTime: proposed,
      handleComment: '改到周二上午',
    });
    expect(result.status).toBe(0);
    expect(result.proposedTime).toBe(proposed.toISOString());
    // requestedTime 一个字未变（默认 MONDAY_10）
    expect(result.requestedTime).toBe(MONDAY_10.toISOString());
    expect(result.handleComment).toBe('改到周二上午');
  });

  it('不传 comment → handleComment 落 null', async () => {
    const h = buildService();
    await h.service.reschedule(21n, rescheduleDto(), caller());

    expect(h.updateIfPending).toHaveBeenCalledWith(21n, {
      proposedTime: new Date('2026-11-03T02:00:00.000Z'),
      handleComment: null,
    });
  });
});

describe('AppointmentService 条件更新：并发里输掉的一方', () => {
  /**
   * 守卫 3 的读与写之间有窗口：两个并发请求都读到 `status=0`，写时只有一个
   * `updateMany({ where: { status: 0 } })` 能命中，另一个拿到 `count=0`。
   * `updateIfPending` 返回 null 就是这种情况——必须是 409 / 32003，不是 200。
   */
  it('confirm 的条件更新没命中 → 409 / 32003', async () => {
    const h = buildService({ updateResult: null });
    const error = await captureError(
      h.service.confirm(21n, confirmDto({ comment: 'x' }), caller()),
    );

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.APPOINTMENT_TRANSITION_INVALID,
      message: '当前状态不允许该操作',
    });
  });

  it('reject 的条件更新没命中 → 409 / 32003', async () => {
    const h = buildService({ updateResult: null });
    const error = await captureError(
      h.service.reject(21n, rejectDto({ reason: 'x' }), caller()),
    );

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.APPOINTMENT_TRANSITION_INVALID,
      message: '当前状态不允许该操作',
    });
  });

  it('reschedule 的条件更新没命中 → 409 / 32003', async () => {
    const h = buildService({ updateResult: null });
    const error = await captureError(
      h.service.reschedule(21n, rescheduleDto(), caller()),
    );

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.APPOINTMENT_TRANSITION_INVALID,
      message: '当前状态不允许该操作',
    });
  });
});

// ── Task 25：学生取消 ──────────────────────────────────────────────

describe('AppointmentService cancel 守卫链：404 → 403 → 409', () => {
  it('天花板绊线不过 → 403 / 10003，一个查询都不发', async () => {
    const h = buildService({ tripwire: true });
    const error = await captureError(h.service.cancel(21n, caller()));

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.FORBIDDEN,
      message: '无权限',
    });
    expect(h.findById).not.toHaveBeenCalled();
    expect(h.updateIfCancellable).not.toHaveBeenCalled();
  });

  it('预约不存在 / 已软删 → 404 / 32001，不解析身份、不落库', async () => {
    const h = buildService({ appointmentRow: null });
    const error = await captureError(h.service.cancel(999999n, caller()));

    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.APPOINTMENT_NOT_FOUND,
      message: '预约不存在',
    });
    expect(h.findPersonByLogin).not.toHaveBeenCalled();
    expect(h.updateIfCancellable).not.toHaveBeenCalled();
  });

  it('别的学生（personId 不符）→ 403 / 32002，不落库', async () => {
    const h = buildService({ personRow: personRow({ id: 8n }) });
    const error = await captureError(h.service.cancel(21n, caller()));

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.APPOINTMENT_FORBIDDEN,
      message: '无权访问该预约',
    });
    expect(h.updateIfCancellable).not.toHaveBeenCalled();
  });

  it('导师（personId 与申请人不同）→ 403 / 32002（不是 10003）', async () => {
    const h = buildService({
      personRow: personRow({ id: 9n, personType: 'internalMentor' }),
    });
    const error = await captureError(h.service.cancel(21n, caller()));

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.APPOINTMENT_FORBIDDEN,
      message: '无权访问该预约',
    });
    expect(h.updateIfCancellable).not.toHaveBeenCalled();
  });

  it('状态不在 0 / 1（2 / 3 / 6 / 7 / 9）→ 409 / 32003，不落库', async () => {
    for (const status of [2, 3, 6, 7, 9]) {
      const h = buildService({ appointmentRow: appointmentRow({ status }) });
      const error = await captureError(h.service.cancel(21n, caller()));

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({
        code: ErrorCode.APPOINTMENT_TRANSITION_INVALID,
        message: '当前状态不允许该操作',
      });
      expect(h.updateIfCancellable).not.toHaveBeenCalled();
    }
  });
});

describe('AppointmentService cancel 正例', () => {
  it('0 PENDING → 8 CANCELLED：条件更新只收 id，响应为显式映射', async () => {
    const h = buildService();
    const result = await h.service.cancel(21n, caller());

    expect(h.updateIfCancellable).toHaveBeenCalledWith(21n);
    expect(result.status).toBe(8);
  });

  it('1 CONFIRMED → 8 CANCELLED', async () => {
    const h = buildService({
      appointmentRow: appointmentRow({ status: 1 }),
    });
    const result = await h.service.cancel(21n, caller());

    expect(h.updateIfCancellable).toHaveBeenCalledWith(21n);
    expect(result.status).toBe(8);
  });

  it('条件更新没命中（并发里输掉的一方）→ 409 / 32003', async () => {
    const h = buildService({ cancelUpdateResult: null });
    const error = await captureError(h.service.cancel(21n, caller()));

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.APPOINTMENT_TRANSITION_INVALID,
      message: '当前状态不允许该操作',
    });
  });
});

// ── Task 25：超时扫描 ──────────────────────────────────────────────

describe('AppointmentService expireOverdue', () => {
  it('TTL 读 SysConfig 的 appointment.pending_ttl_hours，默认 72；cutoff = now − 72h', async () => {
    const h = buildService({ expireCount: 2 });
    const now = new Date('2026-10-30T12:00:00.000Z');

    const result = await h.service.expireOverdue(now);

    expect(h.sysConfigGetNumber).toHaveBeenCalledWith(
      'appointment.pending_ttl_hours',
      72,
    );
    expect(h.expirePendingBefore).toHaveBeenCalledWith(
      new Date('2026-10-27T12:00:00.000Z'),
    );
    expect(result).toEqual({ expired: 2, completed: 0 });
  });

  it('TTL 配成 0 → cutoff 就是 now（过一点就算超时）', async () => {
    const h = buildService({ ttlHours: 0 });
    const now = new Date('2026-10-30T12:00:00.000Z');

    await h.service.expireOverdue(now);

    expect(h.expirePendingBefore).toHaveBeenCalledWith(now);
  });

  it('TTL 配成负数 → 按 0 处理（R34）：cutoff 仍是 now，不落到未来', async () => {
    const h = buildService({ ttlHours: -1 });
    const now = new Date('2026-10-30T12:00:00.000Z');

    await h.service.expireOverdue(now);

    expect(h.expirePendingBefore).toHaveBeenCalledWith(now);
  });

  it('宽限期读 appointment.confirmed_grace_hours，默认 24；confirmed cutoff = now − 24h', async () => {
    const h = buildService({ confirmedCount: 3 });
    const now = new Date('2026-10-30T12:00:00.000Z');

    const result = await h.service.expireOverdue(now);

    expect(h.sysConfigGetNumber).toHaveBeenCalledWith(
      'appointment.confirmed_grace_hours',
      24,
    );
    expect(h.expireConfirmedBefore).toHaveBeenCalledWith(
      new Date('2026-10-29T12:00:00.000Z'),
    );
    expect(result).toEqual({ expired: 3, completed: 0 });
  });

  it('宽限期配成负数 → 按 0 处理（R34 同口径）：confirmed cutoff 仍是 now', async () => {
    const h = buildService({ graceHours: -1 });
    const now = new Date('2026-10-30T12:00:00.000Z');

    await h.service.expireOverdue(now);

    expect(h.expireConfirmedBefore).toHaveBeenCalledWith(now);
  });

  it('返回两段命中数之和（PENDING + CONFIRMED），`completed` 单列', async () => {
    const h = buildService({ expireCount: 2, confirmedCount: 3 });
    const result = await h.service.expireOverdue();

    expect(result).toEqual({ expired: 5, completed: 0 });
  });

  it('没有命中行 → expired = 0（幂等的第二次）', async () => {
    const h = buildService({ expireCount: 0 });
    const result = await h.service.expireOverdue();

    expect(result).toEqual({ expired: 0, completed: 0 });
  });

  // ── P3 Task 34 / R52：评价窗口到期 → 4 推进到 6 ──────────────────

  it('评价窗口读 appointment.review_ttl_days，默认 30 天；cutoff = now − 30d', async () => {
    const h = buildService({ studentConfirmedCount: 4 });
    const now = new Date('2026-11-30T12:00:00.000Z');

    const result = await h.service.expireOverdue(now);

    expect(h.sysConfigGetNumber).toHaveBeenCalledWith(
      'appointment.review_ttl_days',
      30,
    );
    expect(h.expireStudentConfirmedBefore).toHaveBeenCalledWith(
      new Date('2026-10-31T12:00:00.000Z'),
    );
    expect(result).toEqual({ expired: 0, completed: 4 });
  });

  it('评价窗口配成 0 → cutoff 就是 now（过一点就算关窗）', async () => {
    const h = buildService({ reviewDays: 0 });
    const now = new Date('2026-11-30T12:00:00.000Z');

    await h.service.expireOverdue(now);

    expect(h.expireStudentConfirmedBefore).toHaveBeenCalledWith(now);
  });

  it('评价窗口配成负数 → 按 0 处理（R34 同口径）：不把刚确认的预约扫成 6', async () => {
    const h = buildService({ reviewDays: -1 });
    const now = new Date('2026-11-30T12:00:00.000Z');

    await h.service.expireOverdue(now);

    // 不 clamp 的话 cutoff = now + 1d，未来时间，所有 status=4 的行都会被扫掉
    expect(h.expireStudentConfirmedBefore).toHaveBeenCalledWith(now);
  });
});

// ── Task 27：学生确认记录 / 提异议 ────────────────────────────────

function disputeDto(
  overrides: Partial<DisputeAppointmentDto> = {},
): DisputeAppointmentDto {
  return { reason: '记录中的实际指导时间与当天安排不符', ...overrides };
}

describe('AppointmentService 学生侧守卫链：404 → 403 → 409（确认记录 / 提异议）', () => {
  it('天花板绊线不过 → 403 / 10003，一个查询都不发（两个动作各一次）', async () => {
    for (const run of [
      (h: Harness) => h.service.confirmRecord(21n, caller()),
      (h: Harness) => h.service.dispute(21n, disputeDto(), caller()),
    ]) {
      const h = buildService({ tripwire: true });
      const error = await captureError(run(h));

      expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
      expect(error.getResponse()).toMatchObject({
        code: ErrorCode.FORBIDDEN,
        message: '无权限',
      });
      expect(h.findById).not.toHaveBeenCalled();
      expect(h.updateIfRecordSubmitted).not.toHaveBeenCalled();
    }
  });

  it('预约不存在 / 已软删 → 404 / 32001，不解析身份、不落库（两个动作各一次）', async () => {
    for (const run of [
      (h: Harness) => h.service.confirmRecord(999999n, caller()),
      (h: Harness) => h.service.dispute(999999n, disputeDto(), caller()),
    ]) {
      const h = buildService({ appointmentRow: null });
      const error = await captureError(run(h));

      expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
      expect(error.getResponse()).toMatchObject({
        code: ErrorCode.APPOINTMENT_NOT_FOUND,
        message: '预约不存在',
      });
      expect(h.findPersonByLogin).not.toHaveBeenCalled();
      expect(h.updateIfRecordSubmitted).not.toHaveBeenCalled();
    }
  });

  it('别的学生（personId 不符）→ 403 / 32002，不落库', async () => {
    const h = buildService({ personRow: personRow({ id: 8n }) });
    const error = await captureError(h.service.confirmRecord(21n, caller()));

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.APPOINTMENT_FORBIDDEN,
      message: '无权访问该预约',
    });
    expect(h.updateIfRecordSubmitted).not.toHaveBeenCalled();
  });

  it('守卫顺序：别人的、且 status = 6 的预约 → 403 / 32002（不是 32003）', async () => {
    const h = buildService({
      personRow: personRow({ id: 8n }),
      appointmentRow: appointmentRow({ status: 6 }),
    });
    const error = await captureError(
      h.service.dispute(21n, disputeDto(), caller()),
    );

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.APPOINTMENT_FORBIDDEN,
      message: '无权访问该预约',
    });
    expect(h.updateIfRecordSubmitted).not.toHaveBeenCalled();
  });

  it('状态不在 3（0 / 1 / 4 / 6）→ 409 / 32003，不落库（两个动作各一次）', async () => {
    for (const status of [0, 1, 4, 6]) {
      for (const run of [
        (h: Harness) => h.service.confirmRecord(21n, caller()),
        (h: Harness) => h.service.dispute(21n, disputeDto(), caller()),
      ]) {
        const h = buildService({
          appointmentRow: appointmentRow({ status }),
        });
        const error = await captureError(run(h));

        expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
        expect(error.getResponse()).toMatchObject({
          code: ErrorCode.APPOINTMENT_TRANSITION_INVALID,
          message: '当前状态不允许该操作',
        });
        expect(h.updateIfRecordSubmitted).not.toHaveBeenCalled();
      }
    }
  });
});

describe('AppointmentService confirmRecord', () => {
  it('3 → 4 STUDENT_CONFIRMED：落库写 status 4 + 清空 disputeReason（R36），**不写 6**', async () => {
    const h = buildService({
      appointmentRow: appointmentRow({
        status: 3,
        disputeReason: '上一轮未决的异议',
      }),
    });
    const result = await h.service.confirmRecord(21n, caller());

    expect(h.updateIfRecordSubmitted).toHaveBeenCalledWith(21n, {
      status: 4,
      disputeReason: null,
    });
    expect(result.status).toBe(4);
    expect(result.disputeReason).toBeNull();
  });

  it('条件更新没命中（并发里输掉的一方）→ 409 / 32003', async () => {
    const h = buildService({
      appointmentRow: appointmentRow({ status: 3 }),
      recordActionUpdateResult: null,
    });
    const error = await captureError(h.service.confirmRecord(21n, caller()));

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.APPOINTMENT_TRANSITION_INVALID,
      message: '当前状态不允许该操作',
    });
  });
});

describe('AppointmentService dispute', () => {
  it('3 → 5 DISPUTED：reason 落 disputeReason（不是 rejectReason）', async () => {
    const h = buildService({ appointmentRow: appointmentRow({ status: 3 }) });
    const result = await h.service.dispute(
      21n,
      disputeDto({ reason: '时间不符，请复核' }),
      caller(),
    );

    expect(h.updateIfRecordSubmitted).toHaveBeenCalledWith(21n, {
      status: 5,
      disputeReason: '时间不符，请复核',
    });
    expect(result.status).toBe(5);
    expect(result.disputeReason).toBe('时间不符，请复核');
    expect(result.rejectReason).toBeNull();
  });

  it('条件更新没命中（并发里输掉的一方）→ 409 / 32003', async () => {
    const h = buildService({
      appointmentRow: appointmentRow({ status: 3 }),
      recordActionUpdateResult: null,
    });
    const error = await captureError(
      h.service.dispute(21n, disputeDto(), caller()),
    );

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.APPOINTMENT_TRANSITION_INVALID,
      message: '当前状态不允许该操作',
    });
  });
});

function adjudicateDto(
  overrides: Partial<AdjudicateAppointmentDto> = {},
): AdjudicateAppointmentDto {
  return {
    decision: 'uphold',
    comment: '异议成立，记录确与当日安排不符',
    ...overrides,
  };
}

function submitRecordDto(
  overrides: Partial<SubmitGuidanceRecordDto> = {},
): SubmitGuidanceRecordDto {
  return {
    actualTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    mode: 1,
    coreContent: '重填后的核心指导内容',
    followUp: '重填后的后续建议',
    ...overrides,
  };
}

describe('AppointmentService adjudicate 守卫链：404 → 403 → 409', () => {
  it('预约不存在 / 已软删 → 404 / 32001，不解析数据范围、不落库', async () => {
    const h = buildService({ appointmentRow: null });
    const error = await captureError(
      h.service.adjudicate(999999n, adjudicateDto(), caller()),
    );

    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.APPOINTMENT_NOT_FOUND,
      message: '预约不存在',
    });
    expect(h.findStudentOrgDeptId).not.toHaveBeenCalled();
    expect(h.updateIfDisputed).not.toHaveBeenCalled();
  });

  it('申请人学院不在数据范围内 → 403 / 10003（不是 404 / 32002），不落库', async () => {
    const h = buildService({
      appointmentRow: appointmentRow({ status: 5 }),
      scope: { kind: 'depts', deptIds: [3n] },
      studentDeptId: 4n,
    });
    const error = await captureError(
      h.service.adjudicate(21n, adjudicateDto(), caller()),
    );

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.FORBIDDEN,
      message: '无权限',
    });
    expect(h.assertDeptVisible).toHaveBeenCalledWith(
      { kind: 'depts', deptIds: [3n] },
      4n,
    );
    expect(h.updateIfDisputed).not.toHaveBeenCalled();
  });

  it('申请人没有部门投影且范围不是 all → 403 / 10003（fail-closed）', async () => {
    const h = buildService({
      appointmentRow: appointmentRow({ status: 5 }),
      scope: { kind: 'depts', deptIds: [3n] },
      studentDeptId: null,
    });
    const error = await captureError(
      h.service.adjudicate(21n, adjudicateDto(), caller()),
    );

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.FORBIDDEN,
      message: '无权限',
    });
    expect(h.updateIfDisputed).not.toHaveBeenCalled();
  });

  it('守卫顺序：外院且 status = 6 → 403（不是 409），先判权限再判状态', async () => {
    const h = buildService({
      appointmentRow: appointmentRow({ status: 6 }),
      scope: { kind: 'depts', deptIds: [3n] },
      studentDeptId: 4n,
    });
    const error = await captureError(
      h.service.adjudicate(21n, adjudicateDto(), caller()),
    );

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.getResponse()).toMatchObject({ code: ErrorCode.FORBIDDEN });
    expect(h.updateIfDisputed).not.toHaveBeenCalled();
  });

  it('status 不在 5（0 / 3 / 4 / 6）→ 409 / 32003，不落库', async () => {
    for (const status of [0, 3, 4, 6]) {
      const h = buildService({
        appointmentRow: appointmentRow({ status }),
        scope: { kind: 'depts', deptIds: [3n] },
        studentDeptId: 3n,
      });
      const error = await captureError(
        h.service.adjudicate(21n, adjudicateDto(), caller()),
      );

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({
        code: ErrorCode.APPOINTMENT_TRANSITION_INVALID,
        message: '当前状态不允许该操作',
      });
      expect(h.updateIfDisputed).not.toHaveBeenCalled();
    }
  });
});

describe('AppointmentService adjudicate 两个分支', () => {
  it('uphold：5 → 6 COMPLETED，comment 落 adjudicateComment，disputeReason 清空', async () => {
    const h = buildService({
      appointmentRow: appointmentRow({
        status: 5,
        disputeReason: '学生提出的异议',
      }),
      scope: { kind: 'depts', deptIds: [3n] },
      studentDeptId: 3n,
    });
    const result = await h.service.adjudicate(
      21n,
      adjudicateDto({ decision: 'uphold', comment: '异议成立' }),
      caller(),
    );

    expect(h.updateIfDisputed).toHaveBeenCalledWith(21n, {
      status: 6,
      adjudicateComment: '异议成立',
      disputeReason: null,
    });
    expect(result.status).toBe(6);
    expect(result.adjudicateComment).toBe('异议成立');
  });

  it('return：5 → 3 RECORD_SUBMITTED，**不传 disputeReason**（R36 保留原异议）', async () => {
    const h = buildService({
      appointmentRow: appointmentRow({ status: 5 }),
      scope: { kind: 'depts', deptIds: [3n] },
      studentDeptId: 3n,
      disputedUpdateResult: appointmentRow({
        status: 3,
        disputeReason: '学生提出的异议',
        adjudicateComment: '退回重填',
      }),
    });
    const result = await h.service.adjudicate(
      21n,
      adjudicateDto({ decision: 'return', comment: '退回重填' }),
      caller(),
    );

    // 精确相等：`return` 分支的 data 里**不能出现** `disputeReason`（R36 保留原值）
    expect(h.updateIfDisputed).toHaveBeenCalledWith(21n, {
      status: 3,
      adjudicateComment: '退回重填',
    });
    expect(result.status).toBe(3);
    expect(result.disputeReason).toBe('学生提出的异议');
    expect(result.adjudicateComment).toBe('退回重填');
  });

  it('{kind:all} 可以复核没有部门投影的申请人（放行）', async () => {
    const h = buildService({
      appointmentRow: appointmentRow({ status: 5 }),
      scope: { kind: 'all' },
      studentDeptId: null,
    });
    const result = await h.service.adjudicate(21n, adjudicateDto(), caller());
    expect(result.status).toBe(6);
  });

  it('条件更新没命中（并发里输掉的一方）→ 409 / 32003', async () => {
    const h = buildService({
      appointmentRow: appointmentRow({ status: 5 }),
      scope: { kind: 'depts', deptIds: [3n] },
      studentDeptId: 3n,
      disputedUpdateResult: null,
    });
    const error = await captureError(
      h.service.adjudicate(21n, adjudicateDto(), caller()),
    );

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.APPOINTMENT_TRANSITION_INVALID,
      message: '当前状态不允许该操作',
    });
  });
});

describe('AppointmentService submitRecord：R19 首次填报 / R37 重填', () => {
  it('1 CONFIRMED → createRecordWithTransition（建记录 + 1→3），不走重填', async () => {
    const h = buildService({
      appointmentRow: appointmentRow({ status: 1 }),
    });
    const result = await h.service.submitRecord(
      21n,
      submitRecordDto(),
      caller(),
    );

    expect(h.createRecordWithTransition).toHaveBeenCalledTimes(1);
    expect(h.updateRecordWithTransition).not.toHaveBeenCalled();
    expect(result.appointmentId).toBe('21');
    expect(result.coreContent).toBe('核心指导内容');
  });

  it('3 RECORD_SUBMITTED → updateRecordWithTransition（更新记录、保持 3），不建新记录', async () => {
    const h = buildService({
      appointmentRow: appointmentRow({ status: 3 }),
      recordSubmitResult: {
        kind: 'updated',
        record: recordRow({
          coreContent: '重填后的核心指导内容',
          followUp: '重填后的后续建议',
        }),
      },
    });
    const result = await h.service.submitRecord(
      21n,
      submitRecordDto(),
      caller(),
    );

    expect(h.updateRecordWithTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        appointmentId: 21n,
        coreContent: '重填后的核心指导内容',
        followUp: '重填后的后续建议',
        submittedBy: 9n,
      }),
    );
    expect(h.createRecordWithTransition).not.toHaveBeenCalled();
    expect(result.coreContent).toBe('重填后的核心指导内容');
  });

  it('状态不在 1 / 3（0 / 4 / 5 / 6）→ 409 / 32003，两个落库方法都不调', async () => {
    for (const status of [0, 4, 5, 6]) {
      const h = buildService({ appointmentRow: appointmentRow({ status }) });
      const error = await captureError(
        h.service.submitRecord(21n, submitRecordDto(), caller()),
      );

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({
        code: ErrorCode.APPOINTMENT_TRANSITION_INVALID,
      });
      expect(h.createRecordWithTransition).not.toHaveBeenCalled();
      expect(h.updateRecordWithTransition).not.toHaveBeenCalled();
    }
  });

  it('重填时条件更新没命中（并发里状态已推进）→ 409 / 32003', async () => {
    const h = buildService({
      appointmentRow: appointmentRow({ status: 3 }),
      recordSubmitResult: { kind: 'transition-invalid' },
    });
    const error = await captureError(
      h.service.submitRecord(21n, submitRecordDto(), caller()),
    );

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.APPOINTMENT_TRANSITION_INVALID,
      message: '当前状态不允许该操作',
    });
  });

  it('重填也只许该预约的导师本人：别人的单 → 403 / 32002', async () => {
    const h = buildService({
      appointmentRow: appointmentRow({ status: 3, mentorProfileId: 6n }),
    });
    const error = await captureError(
      h.service.submitRecord(21n, submitRecordDto(), caller()),
    );

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.APPOINTMENT_FORBIDDEN,
      message: '无权访问该预约',
    });
    expect(h.updateRecordWithTransition).not.toHaveBeenCalled();
  });
});
