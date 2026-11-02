import { HttpStatus } from '@nestjs/common';
import type { MentorProfile, MentorTimeSlot } from '@prisma/client';
import { ErrorCode } from '../../common/constants/error-code';
import type { DataScopeFilter } from '../../common/constants/data-scope';
import type { RequestUser } from '../../common/context/request-context';
import { BusinessException } from '../../common/errors/business.exception';
import type { DataScopeService } from '../data-scope/data-scope.service';
import type { UserService } from '../user/user.service';
import type { CreateSlotDto } from './dto/create-slot.dto';
import type { UpdateSlotDto } from './dto/update-slot.dto';
import { MentorSlotService } from './mentor-slot.service';
import type { MentorSlotRepository } from './mentor-slot.repository';

function profileRow(overrides: Partial<MentorProfile> = {}): MentorProfile {
  return {
    id: 5n,
    personId: 7n,
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

function createDto(overrides: Partial<CreateSlotDto> = {}): CreateSlotDto {
  return { weekday: 1, startTime: '09:00', endTime: '11:00', ...overrides };
}

function updateDto(overrides: Partial<UpdateSlotDto> = {}): UpdateSlotDto {
  return { weekday: 1, startTime: '09:00', endTime: '11:00', ...overrides };
}

interface Harness {
  service: MentorSlotService;
  findPersonByLogin: jest.Mock;
  findProfileByPersonId: jest.Mock;
  findManyByProfile: jest.Mock;
  findOwnedById: jest.Mock;
  findOverlapping: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  softDelete: jest.Mock;
  userFindById: jest.Mock;
  resolveScope: jest.Mock;
}

function buildService(
  options: {
    profileRow?: MentorProfile | null;
    personRow?: { id: bigint } | null;
    slots?: MentorTimeSlot[];
    ownedSlot?: MentorTimeSlot | null;
    overlapping?: MentorTimeSlot | null;
    /** 'self' 天花板绊线不过（有人把 @DataScope('self') 改宽了） */
    tripwire?: boolean;
  } = {},
): Harness {
  const findPersonByLogin = jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        options.personRow === undefined ? { id: 7n } : options.personRow,
      ),
    );
  const findProfileByPersonId = jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        options.profileRow === undefined ? profileRow() : options.profileRow,
      ),
    );
  const findManyByProfile = jest
    .fn()
    .mockImplementation(() => Promise.resolve(options.slots ?? []));
  const findOwnedById = jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        options.ownedSlot === undefined ? slotRow() : options.ownedSlot,
      ),
    );
  const findOverlapping = jest
    .fn()
    .mockImplementation(() => Promise.resolve(options.overlapping ?? null));
  const create = jest
    .fn()
    .mockImplementation((_mentorProfileId: bigint, slot: CreateSlotDto) =>
      Promise.resolve(slotRow({ ...slot })),
    );
  const update = jest
    .fn()
    .mockImplementation((_id: bigint, slot: UpdateSlotDto) =>
      Promise.resolve(slotRow({ ...slot })),
    );
  const softDelete = jest.fn().mockImplementation(() => Promise.resolve());
  const userFindById = jest
    .fn()
    .mockImplementation(() => Promise.resolve({ username: 'mentor-a' }));
  const resolveScope = jest
    .fn()
    .mockImplementation((): Promise<DataScopeFilter> =>
      Promise.resolve(
        options.tripwire === true
          ? { kind: 'all' }
          : { kind: 'self', userId: 1n },
      ),
    );

  const service = new MentorSlotService(
    {
      findPersonByLogin,
      findProfileByPersonId,
      findManyByProfile,
      findOwnedById,
      findOverlapping,
      create,
      update,
      softDelete,
    } as unknown as MentorSlotRepository,
    { findById: userFindById } as unknown as UserService,
    { resolve: resolveScope } as unknown as DataScopeService,
  );

  return {
    service,
    findPersonByLogin,
    findProfileByPersonId,
    findManyByProfile,
    findOwnedById,
    findOverlapping,
    create,
    update,
    softDelete,
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

describe('MentorSlotService 身份链与天花板绊线', () => {
  it("'self' 天花板绊线不过 → 403 / 10003，一个查询都不发", async () => {
    const h = buildService({ tripwire: true });
    const error = await captureError(h.service.list(caller()));

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.FORBIDDEN,
      message: '无权限',
    });
    expect(h.findPersonByLogin).not.toHaveBeenCalled();
    expect(h.findManyByProfile).not.toHaveBeenCalled();
  });

  it('身份链解析不出 SyncPerson → 404 / 31102', async () => {
    const h = buildService({ personRow: null });
    const error = await captureError(h.service.list(caller()));

    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_PROFILE_NOT_FOUND,
      message: '导师专业档案不存在',
    });
    expect(h.findProfileByPersonId).not.toHaveBeenCalled();
  });

  it('SyncPerson 在但 MentorProfile 不存在（学生 / 未建档）→ 404 / 31102', async () => {
    const h = buildService({ profileRow: null });
    const error = await captureError(h.service.list(caller()));

    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_PROFILE_NOT_FOUND,
    });
    expect(h.findPersonByLogin).toHaveBeenCalledWith('mentor-a');
    expect(h.findManyByProfile).not.toHaveBeenCalled();
  });

  it('身份链：userId → username → login → personId → profile', async () => {
    const h = buildService();
    await h.service.list(caller());

    expect(h.userFindById).toHaveBeenCalledWith(1n);
    expect(h.findPersonByLogin).toHaveBeenCalledWith('mentor-a');
    expect(h.findProfileByPersonId).toHaveBeenCalledWith(7n);
  });
});

describe('MentorSlotService.list', () => {
  it('映射实体 → DTO（BIGINT 字符串），分页结构 page=1 / pageSize=total', async () => {
    const h = buildService({
      slots: [slotRow(), slotRow({ id: 12n, weekday: 2, startTime: '14:00' })],
    });
    const result = await h.service.list(caller());

    expect(result.total).toBe(2);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(2);
    expect(result.list[0]).toEqual({
      id: '11',
      mentorProfileId: '5',
      weekday: 1,
      startTime: '09:00',
      endTime: '11:00',
      status: 1,
    });
  });

  it('空列表：total / pageSize 都是 0', async () => {
    const h = buildService({ slots: [] });
    const result = await h.service.list(caller());
    expect(result).toMatchObject({ list: [], total: 0, page: 1, pageSize: 0 });
  });
});

describe('MentorSlotService.create', () => {
  it('重叠 → 409 / 31206，无行落库', async () => {
    const h = buildService({ overlapping: slotRow() });
    const error = await captureError(
      h.service.create(
        createDto({ weekday: 1, startTime: '10:00', endTime: '12:00' }),
        caller(),
      ),
    );

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_SLOT_OVERLAP,
      message: '该时段与已有开放时段重叠',
    });
    expect(h.findOverlapping).toHaveBeenCalledWith(
      5n,
      1,
      '10:00',
      '12:00',
      undefined,
    );
    expect(h.create).not.toHaveBeenCalled();
  });

  it('status 缺省落 1（开放）', async () => {
    const h = buildService();
    await h.service.create(createDto(), caller());

    expect(h.create).toHaveBeenCalledWith(5n, {
      weekday: 1,
      startTime: '09:00',
      endTime: '11:00',
      status: 1,
    });
  });

  it('显式 status=0 原样落库', async () => {
    const h = buildService();
    const result = await h.service.create(createDto({ status: 0 }), caller());

    expect(h.create).toHaveBeenCalledWith(5n, {
      weekday: 1,
      startTime: '09:00',
      endTime: '11:00',
      status: 0,
    });
    expect(result.status).toBe(0);
  });

  it('成功：响应带 id / mentorProfileId 字符串与各字段值', async () => {
    const h = buildService();
    const result = await h.service.create(createDto(), caller());

    expect(result).toEqual({
      id: '11',
      mentorProfileId: '5',
      weekday: 1,
      startTime: '09:00',
      endTime: '11:00',
      status: 1,
    });
  });
});

describe('MentorSlotService.update', () => {
  it('时段不存在 / 不属于本人 → 404 / 31201（不是 403），无写', async () => {
    const h = buildService({ ownedSlot: null });
    const error = await captureError(
      h.service.update(99n, updateDto(), caller()),
    );

    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_SLOT_NOT_FOUND,
      message: '可指导时段不存在',
    });
    expect(h.findOwnedById).toHaveBeenCalledWith(99n, 5n);
    expect(h.findOverlapping).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('重叠（排除自己那一行）→ 409 / 31206，无写', async () => {
    const h = buildService({ overlapping: slotRow({ id: 12n }) });
    const error = await captureError(
      h.service.update(
        11n,
        updateDto({ startTime: '10:00', endTime: '12:00' }),
        caller(),
      ),
    );

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_SLOT_OVERLAP,
    });
    // excludeId = 自己那一行（11n），否则改自己会与自己相交
    expect(h.findOverlapping).toHaveBeenCalledWith(
      5n,
      1,
      '10:00',
      '12:00',
      11n,
    );
    expect(h.update).not.toHaveBeenCalled();
  });

  it('status 省略 → 保留原值（已关闭的时段改时间仍是 0，不被打开）', async () => {
    const h = buildService({ ownedSlot: slotRow({ status: 0 }) });
    const result = await h.service.update(
      11n,
      updateDto({ weekday: 3, startTime: '14:00', endTime: '16:00' }),
      caller(),
    );

    expect(h.update).toHaveBeenCalledWith(11n, {
      weekday: 3,
      startTime: '14:00',
      endTime: '16:00',
      status: 0,
    });
    expect(result.status).toBe(0);
  });

  it('成功：整条替换写回，响应为更新后的值', async () => {
    const h = buildService();
    const result = await h.service.update(
      11n,
      updateDto({
        weekday: 3,
        startTime: '14:00',
        endTime: '16:00',
        status: 0,
      }),
      caller(),
    );

    expect(h.update).toHaveBeenCalledWith(11n, {
      weekday: 3,
      startTime: '14:00',
      endTime: '16:00',
      status: 0,
    });
    expect(result).toMatchObject({
      id: '11',
      weekday: 3,
      startTime: '14:00',
      endTime: '16:00',
      status: 0,
    });
  });
});

describe('MentorSlotService.remove（软删）', () => {
  it('时段不存在 / 不属于本人 → 404 / 31201，不软删', async () => {
    const h = buildService({ ownedSlot: null });
    const error = await captureError(h.service.remove(99n, caller()));

    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_SLOT_NOT_FOUND,
    });
    expect(h.softDelete).not.toHaveBeenCalled();
  });

  it('成功：软删打在本人那一行上（不物理删）', async () => {
    const h = buildService();
    await h.service.remove(11n, caller());

    expect(h.softDelete).toHaveBeenCalledWith(11n);
  });
});
