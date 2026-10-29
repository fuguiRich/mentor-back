import { HttpStatus } from '@nestjs/common';
import type {
  MentorApplication,
  MentorProfile,
  SyncPerson,
} from '@prisma/client';
import { ErrorCode } from '../../common/constants/error-code';
import { BusinessException } from '../../common/errors/business.exception';
import type { RequestUser } from '../../common/context/request-context';
import type { DataScopeFilter } from '../../common/constants/data-scope';
import type { DataScopeService } from '../data-scope/data-scope.service';
import type { OpLogService } from '../oplog/oplog.service';
import { MentorMapperProvider } from '../mentor/mentor-mapper.provider';
import type { UserService } from '../user/user.service';
import { MentorApplicationService } from './mentor-application.service';
import type {
  MentorApplicationRepository,
  OnboardSubmissionInput,
  ProfileChangeSubmissionInput,
} from './mentor-application.repository';
import type { ReviewRequestMeta } from './review.service';

function person(
  id: bigint,
  personType: string,
  overrides: Partial<SyncPerson> = {},
): SyncPerson {
  return {
    id,
    login: `login_${id.toString()}`,
    realName: `导师 ${id.toString()}`,
    personType,
    orgUnitId: 1n,
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

function profile(
  id: bigint,
  personId: bigint,
  status: number,
  overrides: Partial<MentorProfile> = {},
): MentorProfile {
  return {
    id,
    personId,
    researchFields: ['创新创业'],
    status,
    summary: '简介',
    researchAchievements: '成果',
    guidanceExperience: '经验',
    affiliateOrg: '合作单位',
    socialRoles: '社会任职',
    createdAt: new Date('2026-10-27T00:00:00.000Z'),
    updatedAt: new Date('2026-10-27T00:00:00.000Z'),
    createdBy: 1n,
    updatedBy: 1n,
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  };
}

function applicationRow(
  overrides: Partial<MentorApplication> = {},
): MentorApplication {
  return {
    id: 1n,
    type: 1,
    applicantId: 7n,
    profileId: 1n,
    snapshot: {},
    status: 2,
    collegeReview: null,
    scReview: null,
    submittedAt: new Date('2026-10-28T03:00:00.000Z'),
    createdAt: new Date('2026-10-28T03:00:00.000Z'),
    updatedAt: new Date('2026-10-28T03:00:00.000Z'),
    createdBy: 1n,
    updatedBy: 1n,
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  };
}

function caller(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    userId: 1n,
    username: 'mentor-a',
    isSuperAdmin: false,
    accessJti: 'jti-test',
    accessExpiresAt: 1893456000,
    ...overrides,
  };
}

interface Harness {
  service: MentorApplicationService;
  findPersonByLogin: jest.Mock;
  findProfileByPersonId: jest.Mock;
  createOnboardSubmission: jest.Mock;
  createProfileChangeSubmission: jest.Mock;
  hasInFlightApplication: jest.Mock;
  opLogRecord: jest.Mock;
  userFindById: jest.Mock;
  resolveScope: jest.Mock;
}

function buildService(
  options: {
    personRow?: SyncPerson | null;
    profileRow?: MentorProfile | null;
    submitted?: MentorApplication;
    scope?: DataScopeFilter;
    /** 模拟 R70 原子资格门 count=0（并发双发的输家） */
    gateMiss?: boolean;
    /** R58：已有在审申请 */
    inFlight?: boolean;
    /** 模拟事务内在审查重没抢到（并发双发的输家） */
    changeMiss?: boolean;
  } = {},
): Harness {
  // 桩全走 jest.fn()：用例里要断言「某个方法**没有**被调用」，手写对象字面量
  // 的桩给不出 mock.calls（auth.service.spec.ts 同款理由）
  const findPersonByLogin = jest
    .fn()
    .mockImplementation((): Promise<SyncPerson | null> =>
      Promise.resolve(
        options.personRow === undefined
          ? person(7n, 'internalMentor')
          : options.personRow,
      ),
    );
  const findProfileByPersonId = jest
    .fn()
    .mockImplementation((): Promise<MentorProfile | null> =>
      Promise.resolve(options.profileRow ?? null),
    );
  const createOnboardSubmission = jest
    .fn()
    .mockImplementation(
      (input: OnboardSubmissionInput): Promise<MentorApplication | null> => {
        if (options.gateMiss === true) {
          return Promise.resolve(null);
        }
        // 与 repository 同款语义：快照在「提交当时的档案」行上装配
        const snapshot = input.buildSnapshot(
          options.profileRow ?? profile(1n, 7n, 0),
        );
        return Promise.resolve(
          options.submitted ??
            applicationRow({
              applicantId: input.applicantId,
              profileId: input.profileId,
              snapshot: snapshot as unknown as MentorApplication['snapshot'],
            }),
        );
      },
    );
  const hasInFlightApplication = jest
    .fn()
    .mockImplementation((): Promise<boolean> =>
      Promise.resolve(options.inFlight === true),
    );
  const createProfileChangeSubmission = jest
    .fn()
    .mockImplementation(
      (
        input: ProfileChangeSubmissionInput,
      ): Promise<MentorApplication | null> => {
        if (options.changeMiss === true) {
          return Promise.resolve(null);
        }
        // 与 repository 同款语义：R67 合并在「事务内回读的当前档案」上装配
        const snapshot = input.buildSnapshot(
          options.profileRow ?? profile(1n, 7n, 2),
        );
        return Promise.resolve(
          options.submitted ??
            applicationRow({
              type: 2,
              applicantId: input.applicantId,
              profileId: input.profileId,
              snapshot: snapshot as unknown as MentorApplication['snapshot'],
            }),
        );
      },
    );
  const opLogRecord = jest.fn().mockImplementation(() => Promise.resolve());
  const userFindById = jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve({ id: 1n, username: 'mentor-a' }),
    );
  const resolveScope = jest
    .fn()
    .mockImplementation((): Promise<DataScopeFilter> =>
      Promise.resolve(options.scope ?? { kind: 'self', userId: 1n }),
    );

  const service = new MentorApplicationService(
    {
      findPersonByLogin,
      findProfileByPersonId,
      createOnboardSubmission,
      createProfileChangeSubmission,
      hasInFlightApplication,
    } as unknown as MentorApplicationRepository,
    { findById: userFindById } as unknown as UserService,
    { resolve: resolveScope } as unknown as DataScopeService,
    // 真实的映射面：deriveMentorType / R68 键名翻译是被测行为的一部分
    new MentorMapperProvider(),
    { record: opLogRecord } as unknown as OpLogService,
  );

  return {
    service,
    findPersonByLogin,
    findProfileByPersonId,
    createOnboardSubmission,
    createProfileChangeSubmission,
    hasInFlightApplication,
    opLogRecord,
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

describe('MentorApplicationService 身份门（§2 解析链 + 身份门）', () => {
  it('personType=student → 403 / 10003（不是 404），一个申请都不落', async () => {
    const h = buildService({ personRow: person(7n, 'student') });
    const error = await captureError(h.service.submitOnboard(caller()));

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.FORBIDDEN,
      message: '只有导师（internalMentor / externalMentor）有专业档案',
    });
    expect(h.findProfileByPersonId).not.toHaveBeenCalled();
    expect(h.createOnboardSubmission).not.toHaveBeenCalled();
  });

  it('SyncPerson 配不上（查不到人）→ 403 / 10003；身份链按 login 查，不是按 id', async () => {
    const h = buildService({ personRow: null });
    const error = await captureError(h.service.submitOnboard(caller()));

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    // 身份链第 2 步：拿 username 去按 login 配人
    expect(h.findPersonByLogin).toHaveBeenCalledWith('mentor-a');
    expect(h.findPersonByLogin).toHaveBeenCalledTimes(1);
    expect(h.createOnboardSubmission).not.toHaveBeenCalled();
  });

  it('SysUser 查不到 → 同判 403（解析不出导师这个人）', async () => {
    const h = buildService();
    h.userFindById.mockResolvedValue(null);

    const error = await captureError(h.service.submitOnboard(caller()));
    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(h.findPersonByLogin).not.toHaveBeenCalled();
  });

  it('数据范围天花板被改宽（resolve 回 all）→ 403：红线 14 的绊线', async () => {
    const h = buildService({ scope: { kind: 'all' } });
    const error = await captureError(h.service.submitOnboard(caller()));

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(h.findProfileByPersonId).not.toHaveBeenCalled();
    expect(h.createOnboardSubmission).not.toHaveBeenCalled();
  });
});

describe('MentorApplicationService.submitOnboard（提交门 + 快照 + 落库）', () => {
  it('未建档 → 404 / 31102「导师专业档案不存在」，不落申请行', async () => {
    const h = buildService({ profileRow: null });
    const error = await captureError(h.service.submitOnboard(caller()));

    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_PROFILE_NOT_FOUND,
      message: '导师专业档案不存在',
    });
    expect(h.createOnboardSubmission).not.toHaveBeenCalled();
  });

  it.each([0, 3])(
    'status=%i 可提交：落库载荷由服务端定死，快照逐字段 + mentorType 推导（R68 键名翻译）',
    async (status) => {
      const row = profile(1n, 7n, status);
      const h = buildService({
        personRow: person(7n, 'internalMentor'),
        profileRow: row,
      });
      const body = await h.service.submitOnboard(caller());

      expect(h.createOnboardSubmission).toHaveBeenCalledTimes(1);
      const [input] = h.createOnboardSubmission.mock.calls[0] as [
        OnboardSubmissionInput,
      ];
      // 写不串行：applicantId / profileId 只来自身份链（caller.userId=1n 不是它）
      expect(input.applicantId).toBe(7n);
      expect(input.profileId).toBe(1n);
      // 快照由 repository 在事务内调 buildSnapshot 取「提交当时的档案」：可填报
      // 6 字段 + 推导的 mentorType；researchAchievements 翻译成 achievements
      //（R68，翻译在 mentor 模块里，本模块不点名标量名）
      const snapshot = input.buildSnapshot(row);
      expect(snapshot).toEqual({
        mentorType: 'internal',
        researchFields: ['创新创业'],
        summary: '简介',
        achievements: '成果',
        guidanceExperience: '经验',
        affiliateOrg: '合作单位',
        socialRoles: '社会任职',
      });
      expect(Object.keys(snapshot).sort()).toEqual([
        'achievements',
        'affiliateOrg',
        'guidanceExperience',
        'mentorType',
        'researchFields',
        'socialRoles',
        'summary',
      ]);

      // 响应映射：BIGINT 对外字符串、对外终态恒 2、审核记录恒 null
      expect(body).toMatchObject({
        id: '1',
        type: 1,
        applicantId: '7',
        status: 2,
        collegeReview: null,
        scReview: null,
        submittedAt: '2026-10-28T03:00:00.000Z',
      });
      expect(body.snapshot).toEqual(snapshot);
    },
  );

  it('mentorType 两分支：externalMentor → external（推导不落列）', async () => {
    const row = profile(2n, 8n, 0);
    const h = buildService({
      personRow: person(8n, 'externalMentor'),
      profileRow: row,
    });
    await h.service.submitOnboard(caller());

    const [input] = h.createOnboardSubmission.mock.calls[0] as [
      OnboardSubmissionInput,
    ];
    expect(input.applicantId).toBe(8n);
    expect(input.buildSnapshot(row).mentorType).toBe('external');
  });

  it.each([
    [1, '导师档案当前状态不允许提交入驻申请'],
    [4, '导师档案当前状态不允许提交入驻申请'],
    [5, '导师档案当前状态不允许提交入驻申请'],
  ])('status=%i → 409 / 31103「%s」，一个字都不写', async (status, message) => {
    const h = buildService({
      personRow: person(7n, 'internalMentor'),
      profileRow: profile(1n, 7n, status),
    });
    const error = await captureError(h.service.submitOnboard(caller()));

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE,
      message,
    });
    expect(h.createOnboardSubmission).not.toHaveBeenCalled();
  });

  it('status=2 → 409 / 31101「导师已入驻，不能重复提交入驻申请」（与 31103 分码）', async () => {
    const h = buildService({
      personRow: person(7n, 'internalMentor'),
      profileRow: profile(1n, 7n, 2),
    });
    const error = await captureError(h.service.submitOnboard(caller()));

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_ALREADY_ONBOARDED,
      message: '导师已入驻，不能重复提交入驻申请',
    });
    expect(h.createOnboardSubmission).not.toHaveBeenCalled();
  });

  it('原子资格门 miss（R70 并发输家）→ 409 / 31103：count=0 一律 31103，不另起新码', async () => {
    // 前置提示这关过得去（status=0），输在事务内的条件更新（count=0 → null）
    const h = buildService({
      personRow: person(7n, 'internalMentor'),
      profileRow: profile(1n, 7n, 0),
      gateMiss: true,
    });
    const error = await captureError(h.service.submitOnboard(caller()));

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE,
      message: '导师档案当前状态不允许提交入驻申请',
    });
  });
});

const CHANGE_META: ReviewRequestMeta = {
  method: 'POST',
  path: '/mentor-applications/profile-change',
};

describe('MentorApplicationService.submitProfileChange（type=2 提交门 + R67 合并快照）', () => {
  it('status=2 可提交：载荷由服务端定死（type=2 / 本人 / 本人档案），R67 合并快照逐字段', async () => {
    const row = profile(1n, 7n, 2);
    const h = buildService({
      personRow: person(7n, 'internalMentor'),
      profileRow: row,
    });
    // 增量语义：只改 summary（清空）与 researchFields（整体替换），其余省略 = 不动
    const body = await h.service.submitProfileChange(
      { summary: null, researchFields: ['新方向'] },
      caller(),
      CHANGE_META,
    );

    expect(h.createProfileChangeSubmission).toHaveBeenCalledTimes(1);
    const [input] = h.createProfileChangeSubmission.mock.calls[0] as [
      ProfileChangeSubmissionInput,
    ];
    expect(input.applicantId).toBe(7n);
    expect(input.profileId).toBe(1n);
    const snapshot = input.buildSnapshot(row);
    expect(snapshot).toEqual({
      mentorType: 'internal',
      researchFields: ['新方向'],
      summary: null,
      achievements: '成果',
      guidanceExperience: '经验',
      // R49：内校恒置 null——「省略 = 不动」对这两列不成立
      affiliateOrg: null,
      socialRoles: null,
    });

    // 响应：type=2、对外终态恒 2；提交留痕 1 行（targetType='application'）
    expect(body).toMatchObject({
      id: '1',
      type: 2,
      applicantId: '7',
      status: 2,
      collegeReview: null,
      scReview: null,
    });
    expect(body.snapshot).toEqual(snapshot);
    expect(h.opLogRecord).toHaveBeenCalledTimes(1);
    const [logged] = h.opLogRecord.mock.calls[0] as [
      { action: string; targetType: string; targetId: string; status: number },
    ];
    expect(logged).toMatchObject({
      action: 'submit-profile-change',
      targetType: 'application',
      targetId: '1',
      status: 1,
    });
  });

  it('R67 逐字段语义：null = 清空、数组 = 整体替换、省略 = 不动（不存 DTO 原文）', async () => {
    const row = profile(2n, 8n, 2, {
      affiliateOrg: '旧单位',
      socialRoles: '旧任职',
    });
    const h = buildService({
      personRow: person(8n, 'externalMentor'),
      profileRow: row,
    });
    await h.service.submitProfileChange(
      { achievements: null, affiliateOrg: '新单位' },
      caller(),
      CHANGE_META,
    );

    const [input] = h.createProfileChangeSubmission.mock.calls[0] as [
      ProfileChangeSubmissionInput,
    ];
    expect(input.buildSnapshot(row)).toEqual({
      mentorType: 'external',
      // 省略 = 不动：存的是合并结果的完整 6 字段，不是 DTO 原文
      researchFields: ['创新创业'],
      summary: '简介',
      achievements: null,
      guidanceExperience: '经验',
      affiliateOrg: '新单位',
      // R49 只对内校置空；校外是增量语义
      socialRoles: '旧任职',
    });
  });

  it('未建档 → 404 / 31102；一个申请都不落', async () => {
    const h = buildService({
      personRow: person(7n, 'internalMentor'),
      profileRow: null,
    });
    const error = await captureError(
      h.service.submitProfileChange({}, caller(), CHANGE_META),
    );

    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_PROFILE_NOT_FOUND,
    });
    expect(h.createProfileChangeSubmission).not.toHaveBeenCalled();
    expect(h.hasInFlightApplication).not.toHaveBeenCalled();
  });

  it('personType=student → 403 / 10003（守卫 1 先于一切）', async () => {
    const h = buildService({ personRow: person(7n, 'student') });
    const error = await captureError(
      h.service.submitProfileChange({}, caller(), CHANGE_META),
    );

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(h.findProfileByPersonId).not.toHaveBeenCalled();
    expect(h.createProfileChangeSubmission).not.toHaveBeenCalled();
  });

  it.each([
    [0, '导师档案还是草稿，改草稿走 PUT /mentor/profile'],
    [3, '导师档案还是草稿，改草稿走 PUT /mentor/profile'],
    [1, '导师专业档案在审，入驻通过后再提信息修改申请'],
    [4, '导师档案当前状态不允许提交信息修改申请'],
    [5, '导师档案当前状态不允许提交信息修改申请'],
  ])(
    'status=%i ≠ 2 → 409 / 31103「%s」，不查在审、不落申请行',
    async (status, message) => {
      const h = buildService({
        personRow: person(7n, 'internalMentor'),
        profileRow: profile(1n, 7n, status),
      });
      const error = await captureError(
        h.service.submitProfileChange({}, caller(), CHANGE_META),
      );

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({
        code: ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE,
        message,
      });
      expect(h.hasInFlightApplication).not.toHaveBeenCalled();
      expect(h.createProfileChangeSubmission).not.toHaveBeenCalled();
      expect(h.opLogRecord).not.toHaveBeenCalled();
    },
  );

  it('R58 在审查重：有 status ∈ {1,2,4,5} 的行 → 409 / 31106「已有在审的申请，不能重复提交」', async () => {
    const h = buildService({
      personRow: person(7n, 'internalMentor'),
      profileRow: profile(1n, 7n, 2),
      inFlight: true,
    });
    const error = await captureError(
      h.service.submitProfileChange({}, caller(), CHANGE_META),
    );

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_APPLICATION_IN_FLIGHT,
      message: '已有在审的申请，不能重复提交',
    });
    expect(h.createProfileChangeSubmission).not.toHaveBeenCalled();
  });

  it('事务内在审查重没抢到（并发双发的输家）→ 同判 409 / 31106', async () => {
    const h = buildService({
      personRow: person(7n, 'internalMentor'),
      profileRow: profile(1n, 7n, 2),
      changeMiss: true,
    });
    const error = await captureError(
      h.service.submitProfileChange({}, caller(), CHANGE_META),
    );

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_APPLICATION_IN_FLIGHT,
    });
  });
});
