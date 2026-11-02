import { HttpStatus } from '@nestjs/common';
import type {
  MentorApplication,
  MentorProfile,
  SyncOrgUnit,
  SyncPerson,
} from '@prisma/client';
import { ErrorCode } from '../../common/constants/error-code';
import { BusinessException } from '../../common/errors/business.exception';
import type { RequestUser } from '../../common/context/request-context';
import type { DataScopeFilter } from '../../common/constants/data-scope';
import type { DataScopeService } from '../data-scope/data-scope.service';
import type { OpLogService } from '../oplog/oplog.service';
import type { UserService } from '../user/user.service';
import type { PrismaTx } from '../../infra/prisma/prisma.service';
import {
  MENTOR_APPLICATION_STATUS,
  MENTOR_APPLICATION_TYPE,
} from './dto/mentor-application-response.dto';
import { MENTOR_PROFILE_STATUS } from '../mentor/dto/mentor-profile.dto';
import { MentorMapperProvider } from '../mentor/mentor-mapper.provider';
import type { MentorRepository } from '../mentor/mentor.repository';
import type { ReviewRecord } from './dto/review.dto';
import {
  COLLEGE_REVIEW_EDGES,
  ReviewService,
  SC_REVIEW_EDGES,
  TRANSITION_EDGES,
  WITHDRAW_EDGE,
  type ReviewRequestMeta,
  type TransitionEdge,
} from './review.service';
import type {
  MentorApplicationRepository,
  MentorApplicationWithApplicant,
  TransitionInput,
} from './mentor-application.repository';

/**
 * 状态机14 组（brief §3）：[1]–[10] 逐条 + [D1]–[D4] 逐类。
 * [1] 是登记组（系统边由 Task 13 的提交事务落，本服务只登记不实现）；
 * [2]–[10] 逐边断落点 / 审核记录 / 档案副作用；[D1]–[D4] 断 409 / 31105 + 留痕。
 * 越权 / 留痕完整性 / 列表收窄在 test/mentor-application-review.e2e-spec.ts。
 */

const {
  SUBMITTED,
  COLLEGE_REVIEWING,
  COLLEGE_REJECTED,
  SC_REVIEWING,
  SC_REJECTED,
  APPROVED,
  WITHDRAWN,
} = MENTOR_APPLICATION_STATUS;

const META: ReviewRequestMeta = {
  method: 'POST',
  path: '/mentor-applications/1/college-review',
};

function orgUnit(
  id: bigint,
  deptId: bigint | null,
  overrides: Partial<SyncOrgUnit> = {},
): SyncOrgUnit {
  return {
    id,
    code: `ORG-${id.toString()}`,
    name: '创新创业学院',
    parentId: null,
    kind: null,
    deptId,
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

function person(id: bigint, overrides: Partial<SyncPerson> = {}): SyncPerson {
  return {
    id,
    login: `login_${id.toString()}`,
    realName: `导师 ${id.toString()}`,
    personType: 'internalMentor',
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

function applicationDetail(
  overrides: Partial<MentorApplication> = {},
  applicant?: SyncPerson,
  org?: SyncOrgUnit | null,
): MentorApplicationWithApplicant {
  return {
    ...applicationRow(overrides),
    applicant: {
      ...(applicant ?? person(7n)),
      orgUnit: org === undefined ? orgUnit(1n, 11n) : org,
    },
  };
}

function caller(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    userId: 1n,
    username: 'reviewer-a',
    isSuperAdmin: false,
    accessJti: 'jti-test',
    accessExpiresAt: 1893456000,
    ...overrides,
  };
}

function decisionDto(
  decision: 'approve' | 'reject',
  comment = '材料齐全，同意',
): { decision: 'approve' | 'reject'; comment: string } {
  return { decision, comment };
}

interface Harness {
  service: ReviewService;
  findDetailById: jest.Mock;
  findPersonByLogin: jest.Mock;
  applyTransition: jest.Mock;
  userFindById: jest.Mock;
  resolveScope: jest.Mock;
  assertDeptVisible: jest.Mock;
  opLogRecord: jest.Mock;
  findProfileById: jest.Mock;
  updateDraft: jest.Mock;
}

function buildService(
  options: {
    application?: MentorApplicationWithApplicant;
    personRow?: SyncPerson | null;
    user?: { id: bigint; username: string; realName: string } | null;
    scope?: DataScopeFilter;
    /** 模拟并发竞态兜底 count=0（applyTransition 回 null） */
    raceMiss?: boolean;
    /** landing.writeProfile 读旧值用的档案行（type=2 的 6 APPROVED 留痕） */
    profileBefore?: MentorProfile | null;
  } = {},
): Harness {
  const application = options.application ?? applicationDetail();
  // 桩全走 jest.fn()：要断言「某个方法**没有**被调用」（auth.service.spec.ts 同款理由）
  const findDetailById = jest
    .fn()
    .mockImplementation((): Promise<MentorApplicationWithApplicant | null> =>
      Promise.resolve(application),
    );
  const findPersonByLogin = jest
    .fn()
    .mockImplementation((): Promise<SyncPerson | null> =>
      Promise.resolve(
        options.personRow === undefined
          ? person(application.applicantId)
          : options.personRow,
      ),
    );
  const applyTransition = jest
    .fn()
    .mockImplementation(
      async (input: TransitionInput): Promise<MentorApplication | null> => {
        if (options.raceMiss === true) {
          return null;
        }
        const row = {
          ...application,
          status: input.to,
          ...(input.reviewField !== undefined && input.record !== undefined
            ? { [input.reviewField]: input.record }
            : {}),
        };
        // 与 repository 同款顺序：先写回、回读申请行、再落两笔留痕
        // （R76：recordLogs 第二参是 tx，桩里给个空句柄照传）
        if (input.landing !== undefined) {
          await input.landing.writeProfile({} as PrismaTx);
          await input.landing.recordLogs(row, {} as PrismaTx);
        }
        return row;
      },
    );
  const findProfileById = jest
    .fn()
    .mockImplementation((): Promise<MentorProfile | null> =>
      Promise.resolve(
        options.profileBefore === undefined
          ? profileRow(1n, application.profileId)
          : options.profileBefore,
      ),
    );
  const updateDraft = jest
    .fn()
    .mockImplementation((): Promise<MentorProfile> =>
      Promise.resolve(profileRow(1n, application.profileId)),
    );
  const userFindById = jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        options.user === undefined
          ? { id: 1n, username: 'reviewer-a', realName: '审核员甲' }
          : options.user,
      ),
    );
  const resolveScope = jest
    .fn()
    .mockImplementation((): Promise<DataScopeFilter> =>
      // 默认给 withdraw 的 self 绊线过的范围（review 两路由对任意过滤器都能过：
      // 申请人有部门投影时走 assertDeptVisible 的桩，桩无条件放行）
      Promise.resolve(options.scope ?? { kind: 'self', userId: 1n }),
    );
  const assertDeptVisible = jest.fn();
  const opLogRecord = jest.fn().mockImplementation(() => Promise.resolve());

  const service = new ReviewService(
    {
      findDetailById,
      findPersonByLogin,
      applyTransition,
    } as unknown as MentorApplicationRepository,
    { findById: userFindById } as unknown as UserService,
    {
      resolve: resolveScope,
      assertDeptVisible,
    } as unknown as DataScopeService,
    { record: opLogRecord } as unknown as OpLogService,
    {
      findProfileById,
      updateDraft,
    } as unknown as MentorRepository,
    // 真实的映射面：R68 键名翻译是留痕「旧值」取值行为的一部分
    new MentorMapperProvider(),
  );

  return {
    service,
    findDetailById,
    findPersonByLogin,
    applyTransition,
    userFindById,
    resolveScope,
    assertDeptVisible,
    opLogRecord,
    findProfileById,
    updateDraft,
  };
}

/** 落地写回读旧值的档案行（`researchAchievements` 是 Prisma 标量名，R68） */
function profileRow(id: bigint, personId: bigint): MentorProfile {
  return {
    id,
    personId,
    researchFields: ['旧方向'],
    status: 2,
    summary: '旧简介',
    researchAchievements: '旧成果',
    guidanceExperience: '旧经验',
    affiliateOrg: '旧单位',
    socialRoles: '旧任职',
    professionalTitle: '旧职称',
    createdAt: new Date('2026-10-27T00:00:00.000Z'),
    updatedAt: new Date('2026-10-27T00:00:00.000Z'),
    createdBy: 1n,
    updatedBy: 1n,
    deletedAt: null,
    deletedBy: null,
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

/** 断言一次状态机跳写的载荷（落点 / 出发态集合 / 审核记录列 / 档案回写） */
function expectTransition(
  h: Harness,
  input: {
    from: number;
    to: number;
    validFrom: readonly number[];
    reviewField?: 'collegeReview' | 'scReview';
    profileStatus: number | null;
  },
): TransitionInput {
  expect(h.applyTransition).toHaveBeenCalledTimes(1);
  const [applied] = h.applyTransition.mock.calls[0] as [TransitionInput];
  expect(applied.applicationId).toBe(1n);
  expect(applied.profileId).toBe(1n);
  expect([...applied.validFrom]).toEqual([...input.validFrom]);
  // 测试的前提自检：被测那条边的出发态必须在有效出发态集合里
  expect([...applied.validFrom]).toContain(input.from);
  expect(applied.to).toBe(input.to);
  expect(applied.profileStatus).toBe(input.profileStatus);
  if (input.reviewField === undefined) {
    expect(applied.reviewField).toBeUndefined();
    expect(applied.record).toBeUndefined();
  } else {
    expect(applied.reviewField).toBe(input.reviewField);
    expect(applied.record).not.toBeUndefined();
  }
  return applied;
}

/** 成功留痕：before / after 是 {status, collegeReview, scReview} 完整快照 */
function expectOpLogSuccess(
  h: Harness,
  action: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): void {
  expect(h.opLogRecord).toHaveBeenCalledTimes(1);
  const [input] = h.opLogRecord.mock.calls[0] as [
    {
      module: string;
      action: string;
      targetType: string;
      targetId: string;
      status: number;
      before: unknown;
      after: unknown;
    },
  ];
  expect(input).toMatchObject({
    module: 'mentor-application',
    action,
    targetType: 'application',
    targetId: '1',
    status: 1,
  });
  expect(input.before).toEqual(before);
  expect(input.after).toEqual(after);
}

describe('ReviewService 状态机（14 组：[1]–[10] 合法边 + [D1]–[D4] 显式拒绝）', () => {
  it('[1] 1 SUBMITTED → 2 COLLEGE_REVIEWING（系统自动）：登记在案，本服务不实现、无动作通向它', async () => {
    // 登记表逐条 = brief §3 状态机图（10 条边，id 1-10）
    expect(TRANSITION_EDGES).toEqual([
      { id: 1, from: SUBMITTED, to: COLLEGE_REVIEWING, via: 'system' },
      { id: 2, from: SUBMITTED, to: WITHDRAWN, via: 'withdraw' },
      {
        id: 3,
        from: COLLEGE_REVIEWING,
        to: COLLEGE_REJECTED,
        via: 'college-review',
      },
      {
        id: 4,
        from: COLLEGE_REVIEWING,
        to: SC_REVIEWING,
        via: 'college-review',
      },
      { id: 5, from: COLLEGE_REVIEWING, to: WITHDRAWN, via: 'withdraw' },
      { id: 6, from: COLLEGE_REJECTED, to: WITHDRAWN, via: 'withdraw' },
      { id: 7, from: SC_REVIEWING, to: SC_REJECTED, via: 'sc-review' },
      { id: 8, from: SC_REVIEWING, to: APPROVED, via: 'sc-review' },
      { id: 9, from: SC_REJECTED, to: SC_REVIEWING, via: 'college-review' },
      {
        id: 10,
        from: SC_REJECTED,
        to: COLLEGE_REJECTED,
        via: 'college-review',
      },
    ]);

    // 实现源（动作表）与登记表**双向**一致（tuple = [落点, 合法出发态, via]）：
    // 正向——[2]-[10] 每条登记边都由动作表实现；反向——动作表每个组合
    // （每个出发态 × 落点）都在登记表上，多放一个出发态就是表外的边。
    const realized: Array<[number, readonly number[], TransitionEdge['via']]> =
      [
        [WITHDRAW_EDGE.to, WITHDRAW_EDGE.validFrom, 'withdraw'],
        [
          COLLEGE_REVIEW_EDGES.approve.to,
          COLLEGE_REVIEW_EDGES.approve.validFrom,
          'college-review',
        ],
        [
          COLLEGE_REVIEW_EDGES.reject.to,
          COLLEGE_REVIEW_EDGES.reject.validFrom,
          'college-review',
        ],
        [
          SC_REVIEW_EDGES.approve.to,
          SC_REVIEW_EDGES.approve.validFrom,
          'sc-review',
        ],
        [
          SC_REVIEW_EDGES.reject.to,
          SC_REVIEW_EDGES.reject.validFrom,
          'sc-review',
        ],
      ];
    for (const edge of TRANSITION_EDGES) {
      if (edge.via === 'system') {
        continue;
      }
      const matches = realized.filter(
        ([to, validFrom, via]) =>
          via === edge.via && to === edge.to && validFrom.includes(edge.from),
      );
      expect(matches).toHaveLength(1);
    }
    for (const [to, validFrom, via] of realized) {
      for (const from of validFrom) {
        expect(
          TRANSITION_EDGES.filter(
            (edge) => edge.via === via && edge.from === from && edge.to === to,
          ),
        ).toHaveLength(1);
      }
    }

    // [1] 只登记不实现：没有任何审核动作从 1 出发落到 2（review 动作的
    // 出发态集合不含 1；withdraw 从 1 只落 7——[2]）
    expect(COLLEGE_REVIEW_EDGES.approve.validFrom).not.toContain(SUBMITTED);
    expect(COLLEGE_REVIEW_EDGES.reject.validFrom).not.toContain(SUBMITTED);
    expect(SC_REVIEW_EDGES.approve.validFrom).not.toContain(SUBMITTED);
    expect(SC_REVIEW_EDGES.reject.validFrom).not.toContain(SUBMITTED);

    const h = buildService({ application: applicationDetail({ status: 1 }) });
    const error = await captureError(
      h.service.collegeReview(1n, decisionDto('approve'), caller(), META),
    );
    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(h.applyTransition).not.toHaveBeenCalled();
  });

  it('[2] 1 SUBMITTED → withdraw → 7 WITHDRAWN；档案 → 0 DRAFT', async () => {
    const h = buildService({ application: applicationDetail({ status: 1 }) });
    const body = await h.service.withdraw(1n, caller(), META);

    expect(body.status).toBe(WITHDRAWN);
    expectTransition(h, {
      from: SUBMITTED,
      to: WITHDRAWN,
      validFrom: WITHDRAW_EDGE.validFrom,
      profileStatus: MENTOR_PROFILE_STATUS.DRAFT,
    });
    expectOpLogSuccess(
      h,
      'withdraw',
      { status: 1, collegeReview: null, scReview: null },
      { status: 7, collegeReview: null, scReview: null },
    );
  });

  it('[3] 2 → college reject → 3 COLLEGE_REJECTED；档案 → 3 REJECTED；collegeReview 落 reject 记录', async () => {
    const h = buildService({ application: applicationDetail({ status: 2 }) });
    const body = await h.service.collegeReview(
      1n,
      decisionDto('reject', '材料不全，退回补充'),
      caller(),
      META,
    );

    expect(body.status).toBe(COLLEGE_REJECTED);
    const applied = expectTransition(h, {
      from: COLLEGE_REVIEWING,
      to: COLLEGE_REJECTED,
      validFrom: COLLEGE_REVIEW_EDGES.reject.validFrom,
      reviewField: 'collegeReview',
      profileStatus: MENTOR_PROFILE_STATUS.REJECTED,
    });
    expect(applied.record).toMatchObject({
      reviewerId: '1',
      reviewerName: '审核员甲',
      decision: 'reject',
      comment: '材料不全，退回补充',
    });
    expect(String((applied.record as unknown as ReviewRecord).at)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    // R57：reject 的 comment 非空且逐字落库
    expect((applied.record as unknown as ReviewRecord).comment).toBe(
      '材料不全，退回补充',
    );
  });

  it('[4] 2 → college approve → 4 SC_REVIEWING；档案不动（还在审）', async () => {
    const h = buildService({ application: applicationDetail({ status: 2 }) });
    const body = await h.service.collegeReview(
      1n,
      decisionDto('approve'),
      caller(),
      META,
    );

    expect(body.status).toBe(SC_REVIEWING);
    const applied = expectTransition(h, {
      from: COLLEGE_REVIEWING,
      to: SC_REVIEWING,
      validFrom: COLLEGE_REVIEW_EDGES.approve.validFrom,
      reviewField: 'collegeReview',
      profileStatus: null,
    });
    // R57：approve 的 comment 也必填、也落库
    expect((applied.record as unknown as ReviewRecord).decision).toBe(
      'approve',
    );
    expect((applied.record as unknown as ReviewRecord).comment).toBe(
      '材料齐全，同意',
    );
  });

  it('[5] 2 COLLEGE_REVIEWING → withdraw → 7 WITHDRAWN；档案 → 0 DRAFT', async () => {
    const h = buildService({ application: applicationDetail({ status: 2 }) });
    const body = await h.service.withdraw(1n, caller(), META);

    expect(body.status).toBe(WITHDRAWN);
    expectTransition(h, {
      from: COLLEGE_REVIEWING,
      to: WITHDRAWN,
      validFrom: WITHDRAW_EDGE.validFrom,
      profileStatus: MENTOR_PROFILE_STATUS.DRAFT,
    });
  });

  it('[6] 3 COLLEGE_REJECTED → withdraw → 7 WITHDRAWN；档案 → 0 DRAFT', async () => {
    const h = buildService({ application: applicationDetail({ status: 3 }) });
    const body = await h.service.withdraw(1n, caller(), META);

    expect(body.status).toBe(WITHDRAWN);
    expectTransition(h, {
      from: COLLEGE_REJECTED,
      to: WITHDRAWN,
      validFrom: WITHDRAW_EDGE.validFrom,
      profileStatus: MENTOR_PROFILE_STATUS.DRAFT,
    });
  });

  it('[7] 4 → sc reject → 5 SC_REJECTED；档案**不动**（R73，仍 1 PENDING）；scReview 落 reject 记录', async () => {
    const h = buildService({ application: applicationDetail({ status: 4 }) });
    const body = await h.service.scReview(
      1n,
      decisionDto('reject', '研究方向不符，退回二级学院重审'),
      caller(),
      META,
    );

    expect(body.status).toBe(SC_REJECTED);
    const applied = expectTransition(h, {
      from: SC_REVIEWING,
      to: SC_REJECTED,
      validFrom: SC_REVIEW_EDGES.reject.validFrom,
      reviewField: 'scReview',
      // R73：5 的落点一个字都不写 MentorProfile.status（写了就给申请人开重交口）
      profileStatus: null,
    });
    expect(applied.record).toMatchObject({
      decision: 'reject',
      comment: '研究方向不符，退回二级学院重审',
    });
  });

  it('[8] 4 → sc approve → 6 APPROVED；档案 → 2 APPROVED。type=2 时档案回写恒 null（R59 显式分支）', async () => {
    const h = buildService({ application: applicationDetail({ status: 4 }) });
    const body = await h.service.scReview(
      1n,
      decisionDto('approve', '同意入驻'),
      caller(),
      META,
    );

    expect(body.status).toBe(APPROVED);
    const applied = expectTransition(h, {
      from: SC_REVIEWING,
      to: APPROVED,
      validFrom: SC_REVIEW_EDGES.approve.validFrom,
      reviewField: 'scReview',
      profileStatus: MENTOR_PROFILE_STATUS.APPROVED,
    });
    expect((applied.record as unknown as ReviewRecord).comment).toBe(
      '同意入驻',
    );

    // R59：副作用表只对 type=1 成立——type=2 的落点对那一列一个字都不写
    const h2 = buildService({
      application: applicationDetail({
        status: 4,
        type: MENTOR_APPLICATION_TYPE.PROFILE_CHANGE,
      }),
    });
    await h2.service.scReview(1n, decisionDto('approve'), caller(), META);
    const [applied2] = h2.applyTransition.mock.calls[0] as [TransitionInput];
    expect(applied2.profileStatus).toBeNull();
  });

  it('[8b] type=2 的 6 APPROVED 落地（Task 15）：字段写回取自 snapshot，两笔留痕先 update 再 record（红线 16）', async () => {
    const snapshot = {
      mentorType: 'external',
      researchFields: ['新方向'],
      summary: '新简介',
      achievements: '新成果',
      guidanceExperience: '新经验',
      affiliateOrg: '新单位',
      socialRoles: '新任职',
      professionalTitle: '新职称',
    };
    const h = buildService({
      application: applicationDetail(
        {
          status: 4,
          type: MENTOR_APPLICATION_TYPE.PROFILE_CHANGE,
          snapshot: snapshot as unknown as MentorApplication['snapshot'],
        },
        person(7n, { personType: 'externalMentor' }),
      ),
    });
    await h.service.scReview(
      1n,
      decisionDto('approve', '改字段通过，生效'),
      caller(),
      META,
    );

    // 写回的数据源只能是 snapshot（红线 9）：7 个可填报字段逐字来自提案，
    // status / mentorType 一列不碰
    const [profileId, writeback] = h.updateDraft.mock.calls[0] as [
      bigint,
      Record<string, unknown>,
    ];
    expect(profileId).toBe(1n);
    expect(writeback).toEqual({
      researchFields: ['新方向'],
      summary: '新简介',
      achievements: '新成果',
      guidanceExperience: '新经验',
      affiliateOrg: '新单位',
      socialRoles: '新任职',
      professionalTitle: '新职称',
    });

    // 时序（红线 16）：先写回、再落留痕
    expect(h.updateDraft.mock.invocationCallOrder[0]).toBeLessThan(
      h.opLogRecord.mock.invocationCallOrder[0],
    );

    // 两笔留痕（brief §4）：行 1 targetType='application' + 行 2 'mentorProfile'
    // （7 字段旧值 / 新值完整快照，不是差集）
    expect(h.opLogRecord).toHaveBeenCalledTimes(2);
    const calls = h.opLogRecord.mock.calls as Array<[Record<string, unknown>]>;
    const [row1, row2] = calls.map(([input]) => input);
    expect(row1).toMatchObject({
      module: 'mentor-application',
      action: 'sc-review',
      targetType: 'application',
      targetId: '1',
      status: 1,
    });
    expect(row1.before).toEqual({
      status: 4,
      collegeReview: null,
      scReview: null,
    });
    expect(row1.after).toMatchObject({ status: 6 });
    expect(row2).toMatchObject({
      module: 'mentor-application',
      action: 'sc-review',
      targetType: 'mentorProfile',
      targetId: '1',
      status: 1,
    });
    // 行 2 的「旧值」是写回前的档案行，经 R68 的键名翻译归一（achievements）
    expect(row2.before).toEqual({
      researchFields: ['旧方向'],
      summary: '旧简介',
      achievements: '旧成果',
      guidanceExperience: '旧经验',
      affiliateOrg: '旧单位',
      socialRoles: '旧任职',
      professionalTitle: '旧职称',
    });
    expect(row2.after).toEqual(writeback);
  });

  it('[9] 5 → college approve → 4 SC_REVIEWING（R54 重审）；覆盖 collegeReview；档案不动', async () => {
    const h = buildService({ application: applicationDetail({ status: 5 }) });
    const body = await h.service.collegeReview(
      1n,
      decisionDto('approve', '已核材料无误，再送双创'),
      caller(),
      META,
    );

    expect(body.status).toBe(SC_REVIEWING);
    const applied = expectTransition(h, {
      from: SC_REJECTED,
      to: SC_REVIEWING,
      validFrom: COLLEGE_REVIEW_EDGES.approve.validFrom,
      // 覆盖（留最近一次），不是追加数组——写的就是 collegeReview 这一列
      reviewField: 'collegeReview',
      profileStatus: null,
    });
    expect((applied.record as unknown as ReviewRecord).comment).toBe(
      '已核材料无误，再送双创',
    );
  });

  it('[10] 5 → college reject → 3 COLLEGE_REJECTED（R54 重审不通过）；档案 → 3 REJECTED（这一跳才是退回申请人）', async () => {
    const h = buildService({ application: applicationDetail({ status: 5 }) });
    const body = await h.service.collegeReview(
      1n,
      decisionDto('reject', '重审不通过，退回申请人'),
      caller(),
      META,
    );

    expect(body.status).toBe(COLLEGE_REJECTED);
    expectTransition(h, {
      from: SC_REJECTED,
      to: COLLEGE_REJECTED,
      validFrom: COLLEGE_REVIEW_EDGES.reject.validFrom,
      reviewField: 'collegeReview',
      profileStatus: MENTOR_PROFILE_STATUS.REJECTED,
    });
  });

  it('[D1] 4 SC_REVIEWING → withdraw ✗ 拒：409 / 31105，不落库、留痕 status=0', async () => {
    const h = buildService({ application: applicationDetail({ status: 4 }) });
    const error = await captureError(h.service.withdraw(1n, caller(), META));

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_APPLICATION_TRANSITION_INVALID,
      message: '当前状态不允许该操作',
    });
    expect(h.applyTransition).not.toHaveBeenCalled();
    expect(h.opLogRecord).toHaveBeenCalledTimes(1);
    const [input] = h.opLogRecord.mock.calls[0] as [
      { status: number; errorCode: number; before: unknown; after?: unknown },
    ];
    expect(input.status).toBe(0);
    expect(input.errorCode).toBe(
      ErrorCode.MENTOR_APPLICATION_TRANSITION_INVALID,
    );
    expect(input.before).toEqual({
      status: 4,
      collegeReview: null,
      scReview: null,
    });
    expect(input.after).toBeUndefined();
  });

  it('[D2] 5 SC_REJECTED → withdraw ✗ 拒：409 / 31105（5 也特意排除在可撤范围外）', async () => {
    const h = buildService({ application: applicationDetail({ status: 5 }) });
    const error = await captureError(h.service.withdraw(1n, caller(), META));

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_APPLICATION_TRANSITION_INVALID,
    });
    expect(h.applyTransition).not.toHaveBeenCalled();
    expect(h.opLogRecord).toHaveBeenCalledTimes(1);
  });

  it('[D3] 6 APPROVED → * ✗ 拒（终态）：三个动作都 409 / 31105', async () => {
    for (const run of [
      (h: Harness) =>
        h.service.collegeReview(1n, decisionDto('approve'), caller(), META),
      (h: Harness) =>
        h.service.scReview(1n, decisionDto('reject'), caller(), META),
      (h: Harness) => h.service.withdraw(1n, caller(), META),
    ]) {
      const h = buildService({ application: applicationDetail({ status: 6 }) });
      const error = await captureError(run(h));
      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({
        code: ErrorCode.MENTOR_APPLICATION_TRANSITION_INVALID,
        message: '当前状态不允许该操作',
      });
      expect(h.applyTransition).not.toHaveBeenCalled();
      expect(h.opLogRecord).toHaveBeenCalledTimes(1);
    }
  });

  it('[D4] 7 WITHDRAWN → * ✗ 拒（终态）：三个动作都 409 / 31105', async () => {
    for (const run of [
      (h: Harness) =>
        h.service.collegeReview(1n, decisionDto('reject'), caller(), META),
      (h: Harness) =>
        h.service.scReview(1n, decisionDto('approve'), caller(), META),
      (h: Harness) => h.service.withdraw(1n, caller(), META),
    ]) {
      const h = buildService({ application: applicationDetail({ status: 7 }) });
      const error = await captureError(run(h));
      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({
        code: ErrorCode.MENTOR_APPLICATION_TRANSITION_INVALID,
      });
      expect(h.applyTransition).not.toHaveBeenCalled();
      expect(h.opLogRecord).toHaveBeenCalledTimes(1);
    }
  });
});
