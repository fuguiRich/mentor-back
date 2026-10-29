import { HttpStatus } from '@nestjs/common';
import type { MentorProfile, SyncPerson } from '@prisma/client';
import { ErrorCode } from '../../common/constants/error-code';
import { BusinessException } from '../../common/errors/business.exception';
import type { RequestUser } from '../../common/context/request-context';
import type { DataScopeFilter } from '../../common/constants/data-scope';
import type { PrismaTx } from '../../infra/prisma/prisma.service';
import type { DataScopeService } from '../data-scope/data-scope.service';
import type { OpLogService } from '../oplog/oplog.service';
import type { UserService } from '../user/user.service';
import { MentorService } from './mentor.service';
import type {
  AdminUpdateProfileInput,
  MentorPersonWithOrgUnit,
  MentorProfileDraftWrite,
  MentorRepository,
} from './mentor.repository';
import type { MentorProfileResponseDto } from './dto/mentor-profile.dto';

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
  service: MentorService;
  findPersonByLogin: jest.Mock;
  findByPersonId: jest.Mock;
  create: jest.Mock;
  updateDraft: jest.Mock;
  findPersonById: jest.Mock;
  adminUpdateProfile: jest.Mock;
  userFindById: jest.Mock;
  resolveScope: jest.Mock;
  assertDeptVisible: jest.Mock;
  opLogRecord: jest.Mock;
  /** 事务句柄：留痕必须收到同一个对象（R76 / R77） */
  tx: PrismaTx;
}

/** 操作日志入参的测试形状（只断言本任务关心的键） */
interface RecordedLog {
  module: string;
  action: string;
  targetType?: string;
  targetId?: string;
  status: 0 | 1;
  errorCode?: number;
  before?: unknown;
  after?: unknown;
}

function buildService(
  options: {
    personRow?: SyncPerson | null;
    profileRow?: MentorProfile | null;
    created?: MentorProfile;
    updated?: MentorProfile;
    scope?: DataScopeFilter;
    /** 后台改档：事务内读到的旧行；null = 行不存在（404） */
    adminBefore?: MentorProfile | null;
    /** 后台改档：档案归属人（默认内校导师 7n） */
    adminPerson?: MentorPersonWithOrgUnit | null;
  } = {},
): Harness {
  const tx = {} as PrismaTx;
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
  const findByPersonId = jest
    .fn()
    .mockImplementation((): Promise<MentorProfile | null> =>
      Promise.resolve(options.profileRow ?? null),
    );
  const create = jest
    .fn()
    .mockImplementation(
      (
        personId: bigint,
        draft: MentorProfileDraftWrite,
      ): Promise<MentorProfile> =>
        Promise.resolve(
          options.created ??
            profile(1n, personId, 0, {
              researchFields: draft.researchFields ?? [],
              summary: draft.summary ?? null,
              researchAchievements: draft.achievements ?? null,
              guidanceExperience: draft.guidanceExperience ?? null,
              affiliateOrg: draft.affiliateOrg ?? null,
              socialRoles: draft.socialRoles ?? null,
            }),
        ),
    );
  const updateDraft = jest
    .fn()
    .mockImplementation(
      (_id: bigint, draft: MentorProfileDraftWrite): Promise<MentorProfile> =>
        Promise.resolve(
          options.updated ??
            profile(1n, 7n, 0, {
              researchFields: draft.researchFields ?? ['创新创业'],
              summary: draft.summary ?? '简介',
              researchAchievements: draft.achievements ?? '成果',
              guidanceExperience: draft.guidanceExperience ?? '经验',
              affiliateOrg: draft.affiliateOrg ?? '合作单位',
              socialRoles: draft.socialRoles ?? '社会任职',
            }),
        ),
    );
  const findPersonById = jest
    .fn()
    .mockImplementation((): Promise<MentorPersonWithOrgUnit | null> => {
      if (options.adminPerson !== undefined) {
        return Promise.resolve(options.adminPerson);
      }
      return Promise.resolve({
        ...person(7n, 'internalMentor'),
        orgUnit: null,
      });
    });
  // 模拟仓库的事务：读旧行 → buildDraft（合并）→ 写回 → recordLog（同一 tx）
  const adminUpdateProfile = jest
    .fn()
    .mockImplementation(
      async (input: AdminUpdateProfileInput): Promise<MentorProfile | null> => {
        if (options.adminBefore === null) {
          return null;
        }
        const before = options.adminBefore ?? profile(1n, 7n, 2);
        const draft = await input.buildDraft(before, tx);
        const after = profile(before.id, before.personId, before.status, {
          researchFields: draft.researchFields ?? before.researchFields,
          summary: draft.summary === undefined ? before.summary : draft.summary,
          researchAchievements:
            draft.achievements === undefined
              ? before.researchAchievements
              : draft.achievements,
          guidanceExperience:
            draft.guidanceExperience === undefined
              ? before.guidanceExperience
              : draft.guidanceExperience,
          affiliateOrg:
            draft.affiliateOrg === undefined
              ? before.affiliateOrg
              : draft.affiliateOrg,
          socialRoles:
            draft.socialRoles === undefined
              ? before.socialRoles
              : draft.socialRoles,
        });
        await input.recordLog(before, after, tx);
        return after;
      },
    );
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
  const assertDeptVisible = jest.fn();
  const opLogRecord = jest.fn().mockResolvedValue(undefined);

  const service = new MentorService(
    {
      findPersonByLogin,
      findByPersonId,
      create,
      updateDraft,
      findPersonById,
      adminUpdateProfile,
    } as unknown as MentorRepository,
    { findById: userFindById } as unknown as UserService,
    { resolve: resolveScope, assertDeptVisible } as unknown as DataScopeService,
    { record: opLogRecord } as unknown as OpLogService,
  );

  return {
    service,
    findPersonByLogin,
    findByPersonId,
    create,
    updateDraft,
    findPersonById,
    adminUpdateProfile,
    userFindById,
    resolveScope,
    assertDeptVisible,
    opLogRecord,
    tx,
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

describe('MentorService 身份门（§4.2 身份链 + §0.3 ①）', () => {
  it('personType=student → 403 / 10003（不是 404），GET 与 PUT 都拦', async () => {
    const h = buildService({ personRow: person(7n, 'student') });

    for (const promise of [
      h.service.findMyProfile(caller()),
      h.service.upsertMyProfile({}, caller()),
    ]) {
      const error = await captureError(promise);
      expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
      expect(error.getResponse()).toMatchObject({
        code: ErrorCode.FORBIDDEN,
        message: '只有导师（internalMentor / externalMentor）有专业档案',
      });
    }
  });

  it('SyncPerson 配不上（查不到人）→ 403 / 10003；解析链按 login 查，不是按 id', async () => {
    const h = buildService({ personRow: null });
    const error = await captureError(h.service.findMyProfile(caller()));

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    // 身份链第 2 步：拿 username 去按 login 配人
    expect(h.findPersonByLogin).toHaveBeenCalledWith('mentor-a');
    expect(h.findPersonByLogin).toHaveBeenCalledTimes(1);
  });

  it('SysUser 查不到 → 同判 403（解析不出导师这个人）', async () => {
    const h = buildService();
    h.userFindById.mockResolvedValue(null);

    const error = await captureError(h.service.findMyProfile(caller()));
    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(h.findPersonByLogin).not.toHaveBeenCalled();
  });

  it('数据范围天花板被改宽（resolve 回 all）→ 403：红线 14 的绊线', async () => {
    const h = buildService({ scope: { kind: 'all' } });
    const error = await captureError(h.service.findMyProfile(caller()));

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(h.findByPersonId).not.toHaveBeenCalled();
  });
});

describe('MentorService.findMyProfile', () => {
  it('未建档 → 404 / 31102「导师专业档案不存在」，不做自动建行', async () => {
    const h = buildService({ profileRow: null });
    const error = await captureError(h.service.findMyProfile(caller()));

    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_PROFILE_NOT_FOUND,
      message: '导师专业档案不存在',
    });
    expect(h.create).not.toHaveBeenCalled();
  });

  it('建档后回显：id / personId 是字符串，mentorType 两个分支都推导', async () => {
    const internal = buildService({
      personRow: person(7n, 'internalMentor'),
      profileRow: profile(1n, 7n, 2),
    });
    const internalBody = await internal.service.findMyProfile(caller());
    expect(internalBody).toMatchObject({
      id: '1',
      personId: '7',
      mentorType: 'internal',
      status: 2,
      achievements: '成果',
    });
    expect(typeof internalBody.id).toBe('string');
    expect(typeof internalBody.personId).toBe('string');

    const external = buildService({
      personRow: person(8n, 'externalMentor'),
      profileRow: profile(2n, 8n, 0),
    });
    const externalBody: MentorProfileResponseDto =
      await external.service.findMyProfile(caller());
    expect(externalBody.mentorType).toBe('external');
  });
});

describe('MentorService.upsertMyProfile（upsert + R55 status 门 + R49）', () => {
  it('无行 → 建行：status 恒 0，personId = 本人 SyncPerson.id，缺省 researchFields 落 []', async () => {
    const h = buildService({ personRow: person(7n, 'internalMentor') });
    const body = await h.service.upsertMyProfile(
      { summary: '新简介' },
      caller(),
    );

    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.updateDraft).not.toHaveBeenCalled();
    const [personId, draft] = h.create.mock.calls[0] as [
      bigint,
      MentorProfileDraftWrite,
    ];
    expect(personId).toBe(7n);
    expect(draft.researchFields).toBeUndefined();
    expect(draft.summary).toBe('新简介');
    expect(body.status).toBe(0);
    expect(body.personId).toBe('7');
  });

  it.each([0, 3])(
    'status=%i 可写：走 updateDraft，status 不在写入列里',
    async (status) => {
      const h = buildService({
        personRow: person(7n, 'internalMentor'),
        profileRow: profile(1n, 7n, status),
      });
      await h.service.upsertMyProfile(
        { researchFields: ['人工智能'], summary: '改了' },
        caller(),
      );

      expect(h.updateDraft).toHaveBeenCalledTimes(1);
      expect(h.create).not.toHaveBeenCalled();
      const [id, draft] = h.updateDraft.mock.calls[0] as [
        bigint,
        MentorProfileDraftWrite,
      ];
      expect(id).toBe(1n);
      expect(draft).toEqual({
        researchFields: ['人工智能'],
        summary: '改了',
        achievements: undefined,
        guidanceExperience: undefined,
        affiliateOrg: null,
        socialRoles: null,
      });
      // status 不是草稿列——写入对象里根本不出现它
      expect(Object.keys(draft)).not.toContain('status');
    },
  );

  it.each([
    [1, '导师专业档案在审，撤回后再改'],
    [2, '导师专业档案已生效，改字段走信息修改申请'],
    [4, '导师专业档案已冻结，不能修改'],
    [5, '导师专业档案已移除，不能修改'],
  ])(
    'R55：status=%i → 409 / 31103「%s」，一个字都不写',
    async (status, message) => {
      const h = buildService({
        personRow: person(7n, 'internalMentor'),
        profileRow: profile(1n, 7n, status),
      });
      const error = await captureError(
        h.service.upsertMyProfile({ summary: '不许写' }, caller()),
      );

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({
        code: ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE,
        message,
      });
      expect(h.updateDraft).not.toHaveBeenCalled();
      expect(h.create).not.toHaveBeenCalled();
    },
  );

  it('R49：校内导师传 affiliateOrg / socialRoles → 落库置 NULL（不是 400）', async () => {
    const h = buildService({ personRow: person(7n, 'internalMentor') });
    await h.service.upsertMyProfile(
      { affiliateOrg: '合作单位', socialRoles: '社会任职' },
      caller(),
    );

    const [, draft] = h.create.mock.calls[0] as [
      bigint,
      MentorProfileDraftWrite,
    ];
    expect(draft.affiliateOrg).toBeNull();
    expect(draft.socialRoles).toBeNull();
  });

  it('R49：校外导师传 affiliateOrg / socialRoles → 原样落库', async () => {
    const h = buildService({ personRow: person(8n, 'externalMentor') });
    await h.service.upsertMyProfile(
      { affiliateOrg: '合作单位', socialRoles: '社会任职' },
      caller(),
    );

    const [, draft] = h.create.mock.calls[0] as [
      bigint,
      MentorProfileDraftWrite,
    ];
    expect(draft.affiliateOrg).toBe('合作单位');
    expect(draft.socialRoles).toBe('社会任职');
  });

  it('写不串行：解析出的 personId 只来自身份链，与入参无关', async () => {
    const h = buildService({ personRow: person(7n, 'internalMentor') });
    // 请求体里塞 personId / id / mentorType / status 本该被全局管道拒成 400；
    // 服务层即使拿到它们也只认身份链——这里直接验证 create 挂的是 7n
    await h.service.upsertMyProfile({ summary: 'x' }, caller());
    const [writtenPersonId] = h.create.mock.calls[0] as [
      bigint,
      MentorProfileDraftWrite,
    ];
    expect(writtenPersonId).toBe(7n);
    expect(h.userFindById).toHaveBeenCalledWith(1n);
    expect(h.resolveScope).toHaveBeenCalled();
  });
});

describe('MentorService.adminUpdateProfile（Task 18 后台改档 + 留痕）', () => {
  const meta = { method: 'PUT', path: '/mentor/profiles/1' };

  it('合并到旧值：dto 没给的字段保留旧值；before / after 都是 6 字段完整快照', async () => {
    const h = buildService({
      scope: { kind: 'all' },
      adminBefore: profile(1n, 7n, 2, {
        researchFields: ['旧方向'],
        summary: '旧简介',
        researchAchievements: '旧成果',
        guidanceExperience: '旧经验',
        affiliateOrg: null,
        socialRoles: null,
      }),
    });

    const body = await h.service.adminUpdateProfile(
      1n,
      { summary: '新简介' },
      caller(),
      meta,
    );

    expect(body.summary).toBe('新简介');
    expect(h.adminUpdateProfile).toHaveBeenCalledTimes(1);
    expect(h.opLogRecord).toHaveBeenCalledTimes(1);

    const [input, txArg] = h.opLogRecord.mock.calls[0] as [
      RecordedLog,
      PrismaTx,
    ];
    expect(input).toMatchObject({
      module: 'mentor',
      action: 'admin-update-profile',
      targetType: 'mentorProfile',
      targetId: '1',
      status: 1,
    });
    // 判据 2 / 3：before 是改动前的完整 6 字段，after 是改动后的完整 6 字段
    expect(input.before).toEqual({
      researchFields: ['旧方向'],
      summary: '旧简介',
      achievements: '旧成果',
      guidanceExperience: '旧经验',
      affiliateOrg: null,
      socialRoles: null,
    });
    expect(input.after).toEqual({
      researchFields: ['旧方向'],
      summary: '新简介',
      achievements: '旧成果',
      guidanceExperience: '旧经验',
      affiliateOrg: null,
      socialRoles: null,
    });
    // R76：留痕与落库同一个事务句柄
    expect(txArg).toBe(h.tx);
  });

  it('R49：内校导师传 affiliateOrg / socialRoles → 草稿与 after 都置 null（不是 400）', async () => {
    const h = buildService({ scope: { kind: 'all' } });

    await h.service.adminUpdateProfile(
      1n,
      { affiliateOrg: '合作单位', socialRoles: '社会任职' },
      caller(),
      meta,
    );

    const [input] = h.opLogRecord.mock.calls[0] as [RecordedLog, PrismaTx];
    expect(input.after).toMatchObject({
      affiliateOrg: null,
      socialRoles: null,
    });
  });

  it('R49：外校导师传这两个字段 → 原样落库', async () => {
    const h = buildService({
      scope: { kind: 'all' },
      adminPerson: { ...person(7n, 'externalMentor'), orgUnit: null },
    });

    await h.service.adminUpdateProfile(
      1n,
      { affiliateOrg: '新单位', socialRoles: '新任职' },
      caller(),
      meta,
    );

    const [input] = h.opLogRecord.mock.calls[0] as [RecordedLog, PrismaTx];
    expect(input.after).toMatchObject({
      affiliateOrg: '新单位',
      socialRoles: '新任职',
    });
  });

  it('档案不存在 → 404 / 31102，失败留痕 status=0 + errorCode=31102', async () => {
    const h = buildService({ scope: { kind: 'all' }, adminBefore: null });

    const error = await captureError(
      h.service.adminUpdateProfile(1n, { summary: 'x' }, caller(), meta),
    );

    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_PROFILE_NOT_FOUND,
    });
    const [input] = h.opLogRecord.mock.calls[0] as [RecordedLog, PrismaTx];
    expect(input).toMatchObject({
      status: 0,
      errorCode: ErrorCode.MENTOR_PROFILE_NOT_FOUND,
    });
  });

  it('数据范围 self：改别人的档案 → 403，成功留痕一行都不落', async () => {
    const h = buildService({
      scope: { kind: 'self', userId: 1n },
      // 归属人 8n ≠ 调用者本人的 7n
      adminPerson: { ...person(8n, 'internalMentor'), orgUnit: null },
    });

    const error = await captureError(
      h.service.adminUpdateProfile(1n, { summary: '越权' }, caller(), meta),
    );

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(h.adminUpdateProfile).toHaveBeenCalledTimes(1);
    // 只落失败日志（status=0），没有 status=1 的成功行
    const statuses = (h.opLogRecord.mock.calls as Array<[RecordedLog]>).map(
      ([log]) => log.status,
    );
    expect(statuses).toEqual([0]);
  });
});
