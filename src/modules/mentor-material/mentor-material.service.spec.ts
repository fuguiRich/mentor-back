import { HttpStatus, type StreamableFile } from '@nestjs/common';
import type {
  MentorApplication,
  MentorApplicationMaterial,
  SyncOrgUnit,
  SyncPerson,
  SysFile,
} from '@prisma/client';
import { ErrorCode } from '../../common/constants/error-code';
import type { DataScopeFilter } from '../../common/constants/data-scope';
import type { RequestUser } from '../../common/context/request-context';
import { BusinessException } from '../../common/errors/business.exception';
import type { DataScopeService } from '../data-scope/data-scope.service';
import type { FileService } from '../file/file.service';
import type { UserService } from '../user/user.service';
import type { AttachMaterialDto } from './dto/attach-material.dto';
import { MentorMaterialService } from './mentor-material.service';
import type {
  MaterialApplicationWithApplicant,
  MentorMaterialRepository,
} from './mentor-material.repository';

function orgUnit(
  deptId: bigint | null,
  overrides: Partial<SyncOrgUnit> = {},
): SyncOrgUnit {
  return {
    id: 1n,
    code: 'org-1',
    name: '组织一',
    parentCode: null,
    kind: 'org',
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
  } as SyncOrgUnit;
}

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

function application(
  overrides: {
    status?: number;
    applicantId?: bigint;
    applicant?: SyncPerson & { orgUnit: SyncOrgUnit | null };
  } = {},
): MaterialApplicationWithApplicant {
  const row: MentorApplication = {
    id: 1n,
    type: 1,
    applicantId: overrides.applicantId ?? 7n,
    profileId: 1n,
    snapshot: {},
    status: overrides.status ?? 2,
    collegeReview: null,
    scReview: null,
    submittedAt: new Date('2026-10-28T03:00:00.000Z'),
    createdAt: new Date('2026-10-28T03:00:00.000Z'),
    updatedAt: new Date('2026-10-28T03:00:00.000Z'),
    createdBy: 1n,
    updatedBy: 1n,
    deletedAt: null,
    deletedBy: null,
  };
  return {
    ...row,
    applicant: overrides.applicant ?? {
      ...person(7n, 'internalMentor'),
      orgUnit: orgUnit(10n),
    },
  };
}

function materialRow(
  overrides: Partial<MentorApplicationMaterial> = {},
): MentorApplicationMaterial {
  return {
    id: 11n,
    applicationId: 1n,
    kind: 1,
    fileId: 21n,
    createdAt: new Date('2026-10-29T01:00:00.000Z'),
    updatedAt: new Date('2026-10-29T01:00:00.000Z'),
    createdBy: 1n,
    updatedBy: 1n,
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  };
}

function fileRow(overrides: Partial<SysFile> = {}): SysFile {
  return {
    id: 21n,
    originName: '职称证书.pdf',
    storageName: 'uuid.pdf',
    ext: 'pdf',
    mimeType: 'application/pdf',
    size: 2048,
    sha256: 'a'.repeat(64),
    ownerType: 'MentorApplication',
    ownerId: 1n,
    createdAt: new Date('2026-10-29T00:30:00.000Z'),
    updatedAt: new Date('2026-10-29T00:30:00.000Z'),
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

function attachDto(
  overrides: Partial<AttachMaterialDto> = {},
): AttachMaterialDto {
  return { fileId: '21', kind: 1, ...overrides };
}

interface Harness {
  service: MentorMaterialService;
  findDetailById: jest.Mock;
  findPersonByLogin: jest.Mock;
  findManyByApplication: jest.Mock;
  findActiveById: jest.Mock;
  hasActiveMaterial: jest.Mock;
  create: jest.Mock;
  softDelete: jest.Mock;
  findFilesByIds: jest.Mock;
  userFindById: jest.Mock;
  resolveScope: jest.Mock;
  assertDeptVisible: jest.Mock;
  claimOwnedBy: jest.Mock;
  assertOwnedBy: jest.Mock;
  serve: jest.Mock;
}

function buildService(
  options: {
    applicationRow?: MaterialApplicationWithApplicant | null;
    personRow?: SyncPerson | null;
    materialRow?: MentorApplicationMaterial | null;
    materials?: MentorApplicationMaterial[];
    duplicate?: boolean;
    scope?: DataScopeFilter;
    /** 'self' 天花板绊线不过（有人把 @DataScope('self') 改宽了） */
    tripwire?: boolean;
  } = {},
): Harness {
  // 桩全走 jest.fn()：用例里要断言「某个方法**没有**被调用」，手写对象字面量
  // 的桩给不出 mock.calls（auth.service.spec.ts 同款理由）
  const findDetailById = jest
    .fn()
    .mockImplementation((): Promise<MaterialApplicationWithApplicant | null> =>
      Promise.resolve(
        options.applicationRow === undefined
          ? application()
          : options.applicationRow,
      ),
    );
  const findPersonByLogin = jest
    .fn()
    .mockImplementation((): Promise<SyncPerson | null> =>
      Promise.resolve(
        options.personRow === undefined
          ? person(7n, 'internalMentor')
          : options.personRow,
      ),
    );
  const findManyByApplication = jest
    .fn()
    .mockImplementation((): Promise<MentorApplicationMaterial[]> =>
      Promise.resolve(options.materials ?? []),
    );
  const findActiveById = jest
    .fn()
    .mockImplementation((): Promise<MentorApplicationMaterial | null> =>
      Promise.resolve(options.materialRow ?? null),
    );
  const hasActiveMaterial = jest
    .fn()
    .mockImplementation((): Promise<boolean> =>
      Promise.resolve(options.duplicate === true),
    );
  const create = jest
    .fn()
    .mockImplementation(
      (data: {
        applicationId: bigint;
        kind: number;
        fileId: bigint;
      }): Promise<MentorApplicationMaterial> =>
        Promise.resolve(materialRow({ ...data })),
    );
  const softDelete = jest.fn().mockImplementation(() => Promise.resolve());
  const findFilesByIds = jest
    .fn()
    .mockImplementation((): Promise<SysFile[]> => Promise.resolve([fileRow()]));
  const userFindById = jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve({ id: 1n, username: 'mentor-a', deptId: 10n }),
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
  const assertDeptVisible = jest.fn().mockImplementation(() => undefined);
  const claimOwnedBy = jest.fn().mockImplementation(() => Promise.resolve());
  const assertOwnedBy = jest.fn().mockImplementation(() => Promise.resolve());
  const serve = jest
    .fn()
    .mockImplementation((): Promise<StreamableFile> =>
      Promise.resolve({} as StreamableFile),
    );

  const service = new MentorMaterialService(
    {
      findDetailById,
      findPersonByLogin,
      findManyByApplication,
      findActiveById,
      hasActiveMaterial,
      create,
      softDelete,
      findFilesByIds,
    } as unknown as MentorMaterialRepository,
    { findById: userFindById } as unknown as UserService,
    { resolve: resolveScope, assertDeptVisible } as unknown as DataScopeService,
    { claimOwnedBy, assertOwnedBy, serve } as unknown as FileService,
  );

  return {
    service,
    findDetailById,
    findPersonByLogin,
    findManyByApplication,
    findActiveById,
    hasActiveMaterial,
    create,
    softDelete,
    findFilesByIds,
    userFindById,
    resolveScope,
    assertDeptVisible,
    claimOwnedBy,
    assertOwnedBy,
    serve,
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

describe('MentorMaterialService.attach 守卫顺序（§3 先到先拒）', () => {
  it('① 申请不存在（含软删）→ 404 / 31104，一个写都不发', async () => {
    const h = buildService({ applicationRow: null });
    const error = await captureError(
      h.service.attach(1n, attachDto(), caller()),
    );

    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_APPLICATION_NOT_FOUND,
      message: '入驻申请不存在',
    });
    expect(h.claimOwnedBy).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('② 越权：不是申请人本人 → 403 / 10003（不是 404），无行落库', async () => {
    const h = buildService({ personRow: person(8n, 'internalMentor') });
    const error = await captureError(
      h.service.attach(1n, attachDto(), caller()),
    );

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.FORBIDDEN,
      message: '无权限',
    });
    expect(h.claimOwnedBy).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('② 身份链解析不出人（没配 SyncPerson）→ 同判 403 / 10003', async () => {
    const h = buildService({ personRow: null });
    const error = await captureError(
      h.service.attach(1n, attachDto(), caller()),
    );

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(h.findPersonByLogin).toHaveBeenCalledWith('mentor-a');
    expect(h.create).not.toHaveBeenCalled();
  });

  it('③ personType=student（自己的申请）→ 403 / 10003，文案点名导师', async () => {
    // 申请人默认是 person 7n（application() 的 applicantId），身份链也解析到
    // 同一个 7n，只是 personType 是 student——这样 403 来自身份门而不是越权门
    const h = buildService({ personRow: person(7n, 'student') });
    const error = await captureError(
      h.service.attach(1n, attachDto(), caller()),
    );

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.FORBIDDEN,
      message: '只有导师（internalMentor / externalMentor）能管理佐证材料',
    });
    expect(h.claimOwnedBy).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it("'self' 天花板绊线不过 → 403 / 10003（@DataScope('self') 被改宽时不开宽口）", async () => {
    const h = buildService({ tripwire: true });
    const error = await captureError(
      h.service.attach(1n, attachDto(), caller()),
    );

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('④ status=4 / 5 / 6 / 7 → 各 409 / 31105，归属校验都不发', async () => {
    for (const status of [4, 5, 6, 7]) {
      const h = buildService({ applicationRow: application({ status }) });
      const error = await captureError(
        h.service.attach(1n, attachDto(), caller()),
      );

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({
        code: ErrorCode.MENTOR_APPLICATION_TRANSITION_INVALID,
        message: '当前状态不允许该操作',
      });
      expect(h.claimOwnedBy).not.toHaveBeenCalled();
      expect(h.create).not.toHaveBeenCalled();
    }
  });

  it('⑤ 归属校验按 O5 精确值调用；失败（28101）原样抛出、无行落库', async () => {
    const h = buildService();
    h.claimOwnedBy.mockRejectedValue(
      new BusinessException(ErrorCode.FILE_NOT_FOUND, '文件不存在', 404),
    );
    const error = await captureError(
      h.service.attach(1n, attachDto(), caller()),
    );

    expect(h.claimOwnedBy).toHaveBeenCalledWith(
      '21',
      'MentorApplication',
      '1',
      1n,
    );
    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.FILE_NOT_FOUND,
      message: '文件不存在',
    });
    expect(h.hasActiveMaterial).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('⑥ 同一 fileId 重复挂 → 409 / 10006，无行落库', async () => {
    const h = buildService({ duplicate: true });
    const error = await captureError(
      h.service.attach(1n, attachDto(), caller()),
    );

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.CONFLICT,
      message: '同一文件不能重复挂到同一申请',
    });
    expect(h.create).not.toHaveBeenCalled();
  });

  it('挂接成功：落库载荷 {applicationId, kind, fileId}，响应带文件名 / 大小', async () => {
    const h = buildService();
    const result = await h.service.attach(1n, attachDto(), caller());

    expect(h.create).toHaveBeenCalledWith({
      applicationId: 1n,
      kind: 1,
      fileId: 21n,
    });
    expect(result).toMatchObject({
      id: '11',
      applicationId: '1',
      fileId: '21',
      kind: 1,
      originName: '职称证书.pdf',
      mimeType: 'application/pdf',
      size: 2048,
    });
  });
});

describe('MentorMaterialService.list 可见性（§3：本人或数据范围覆盖申请人部门）', () => {
  it('申请人本人可见：不看数据范围也放行', async () => {
    const h = buildService({
      scope: { kind: 'depts', deptIds: [] },
      materials: [materialRow(), materialRow({ id: 12n, fileId: 22n })],
    });
    const result = await h.service.list(1n, caller());

    expect(h.assertDeptVisible).not.toHaveBeenCalled();
    expect(result.list).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(2);
  });

  it('不是本人：assertDeptVisible(filter, 申请人部门) 拒了 → 403 / 10003', async () => {
    const h = buildService({
      personRow: person(8n, 'internalMentor'),
      scope: { kind: 'depts', deptIds: [99n] },
    });
    h.assertDeptVisible.mockImplementation(() => {
      throw new BusinessException(ErrorCode.FORBIDDEN, '无权限', 403);
    });
    const error = await captureError(h.service.list(1n, caller()));

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(h.assertDeptVisible).toHaveBeenCalledWith(
      { kind: 'depts', deptIds: [99n] },
      10n,
    );
    expect(h.findManyByApplication).not.toHaveBeenCalled();
  });

  it("申请人没有部门投影：只有 {kind:'all'} 可见（fail-closed）", async () => {
    const noDept = {
      ...person(7n, 'internalMentor'),
      orgUnit: orgUnit(null),
    };
    const denied = buildService({
      applicationRow: application({ applicant: noDept }),
      // 调用者必须是**非申请人**，否则 assertReadable 在「本人」那一步就放行了，
      // 根本走不到「申请人没有部门投影」这条 fail-closed 分支
      personRow: person(8n, 'internalMentor'),
      scope: { kind: 'depts', deptIds: [10n] },
    });
    const error = await captureError(denied.service.list(1n, caller()));
    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(denied.assertDeptVisible).not.toHaveBeenCalled();

    const allowed = buildService({
      applicationRow: application({ applicant: noDept }),
      personRow: person(8n, 'internalMentor'),
      scope: { kind: 'all' },
    });
    await expect(allowed.service.list(1n, caller())).resolves.toMatchObject({
      total: 0,
    });
    expect(allowed.assertDeptVisible).not.toHaveBeenCalled();
  });

  it('材料行的文件元数据从 SysFile 行取；行缺失兜底空值不打 500', async () => {
    const h = buildService({ materials: [materialRow()] });
    h.findFilesByIds.mockResolvedValue([]);
    const result = await h.service.list(1n, caller());

    expect(result.list[0]).toMatchObject({
      originName: '',
      mimeType: '',
      size: 0,
    });
  });
});

describe('MentorMaterialService.remove 摘材料（R63 软删）', () => {
  it('守卫顺序：404 / 31104 → 403 越权 → 403 student → 409 / 31105', async () => {
    // status 门在材料查找**之前**：状态不对时连材料都不查
    const h = buildService({
      applicationRow: application({ status: 6 }),
      materialRow: materialRow(),
    });
    const error = await captureError(h.service.remove(1n, 11n, caller()));

    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_APPLICATION_TRANSITION_INVALID,
    });
    expect(h.findActiveById).not.toHaveBeenCalled();
    expect(h.softDelete).not.toHaveBeenCalled();
  });

  it('materialId 不存在 / 已软删 / 不属于本申请 → 404 / 31107', async () => {
    const h = buildService({ materialRow: null });
    const error = await captureError(h.service.remove(1n, 11n, caller()));

    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_MATERIAL_NOT_FOUND,
      message: '佐证材料不存在',
    });
    expect(h.softDelete).not.toHaveBeenCalled();
  });

  it('摘除成功：软删打在材料行上（不物理删）', async () => {
    const h = buildService({ materialRow: materialRow() });
    await h.service.remove(1n, 11n, caller());

    expect(h.softDelete).toHaveBeenCalledWith(11n);
  });
});

describe('MentorMaterialService.preview / download（R60 按申请鉴权的流式出口）', () => {
  it('404 / 31104 → 可见性 403 → 404 / 31107 → assertOwnedBy → serve', async () => {
    // 材料不存在时归属校验与 serve 都不发
    const missing = buildService({ materialRow: null });
    const error = await captureError(
      missing.service.preview(1n, 11n, caller()),
    );
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_MATERIAL_NOT_FOUND,
    });
    expect(missing.assertOwnedBy).not.toHaveBeenCalled();
    expect(missing.serve).not.toHaveBeenCalled();
  });

  it('归属校验按 O5 精确值调（fileId 转字符串），不符同 404 / 28101', async () => {
    const h = buildService({ materialRow: materialRow() });
    h.assertOwnedBy.mockRejectedValue(
      new BusinessException(ErrorCode.FILE_NOT_FOUND, '文件不存在', 404),
    );
    const error = await captureError(h.service.download(1n, 11n, caller()));

    expect(h.assertOwnedBy).toHaveBeenCalledWith(
      '21',
      'MentorApplication',
      '1',
    );
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.FILE_NOT_FOUND,
    });
    expect(h.serve).not.toHaveBeenCalled();
  });

  it("preview → serve(id, 'inline')；download → serve(id, 'attachment', octet-stream)", async () => {
    const previewService = buildService({ materialRow: materialRow() });
    await previewService.service.preview(1n, 11n, caller());
    expect(previewService.serve).toHaveBeenCalledWith(21n, 'inline', undefined);

    const downloadService = buildService({ materialRow: materialRow() });
    await downloadService.service.download(1n, 11n, caller());
    expect(downloadService.serve).toHaveBeenCalledWith(
      21n,
      'attachment',
      'application/octet-stream',
    );
  });
});
