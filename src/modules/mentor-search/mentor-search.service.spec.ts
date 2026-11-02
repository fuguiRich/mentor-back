import { HttpStatus } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ErrorCode } from '../../common/constants/error-code';
import { BusinessException } from '../../common/errors/business.exception';
import { MentorMapperProvider } from '../mentor/mentor-mapper.provider';
import type { QueryMentorDto } from './dto/query-mentor.dto';
import { MentorSearchMapper } from './mentor-search.mapper';
import {
  buildMentorSearchWhere,
  type MentorSearchRow,
  type MentorSearchRepository,
} from './mentor-search.repository';
import { MentorSearchService } from './mentor-search.service';

const SYNCED_AT = new Date('2026-10-27T00:00:00.000Z');
const AUDIT_AT = new Date('2026-10-27T00:00:00.000Z');

function row(overrides: Partial<MentorSearchRow> = {}): MentorSearchRow {
  return {
    id: 5n,
    personId: 7n,
    researchFields: ['人工智能', '软件工程'],
    status: 2,
    summary: '长期从事人工智能研究。',
    researchAchievements: '主持省部级项目 2 项。',
    guidanceExperience: '指导研究生 12 名。',
    affiliateOrg: null,
    socialRoles: null,
    professionalTitle: '教授',
    createdAt: AUDIT_AT,
    updatedAt: AUDIT_AT,
    createdBy: 0n,
    updatedBy: 0n,
    deletedAt: null,
    deletedBy: null,
    person: {
      id: 7n,
      login: 'T001',
      realName: '张明远',
      personType: 'internalMentor',
      orgUnitId: 3n,
      major: null,
      className: null,
      mobile: '13800000000',
      syncedAt: SYNCED_AT,
      syncRunId: null,
      createdAt: AUDIT_AT,
      updatedAt: AUDIT_AT,
      createdBy: 0n,
      updatedBy: 0n,
      deletedAt: null,
      deletedBy: null,
      orgUnit: {
        id: 3n,
        code: 'CS',
        name: '计算机学院',
        parentId: null,
        kind: 'college',
        syncedAt: SYNCED_AT,
        syncRunId: null,
        deptId: 2n,
        createdAt: AUDIT_AT,
        updatedAt: AUDIT_AT,
        createdBy: 0n,
        updatedBy: 0n,
        deletedAt: null,
        deletedBy: null,
      },
    },
    ...overrides,
  };
}

function andClauses(
  where: Prisma.MentorProfileWhereInput,
): Prisma.MentorProfileWhereInput[] {
  expect(Array.isArray(where.AND)).toBe(true);
  return where.AND as Prisma.MentorProfileWhereInput[];
}

function query(overrides: Partial<QueryMentorDto> = {}): QueryMentorDto {
  return { page: 1, pageSize: 20, ...overrides };
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

describe('buildMentorSearchWhere', () => {
  it('一个条件都不传：恒有 status = 2 APPROVED 与「人员未离场」两条', () => {
    expect(buildMentorSearchWhere({})).toEqual({
      AND: [{ status: 2 }, { person: { deletedAt: null } }],
    });
  });

  it('name / professionalTitle 走模糊，deptId 走 person.orgUnit 的学院投影', () => {
    const clauses = andClauses(
      buildMentorSearchWhere({
        name: '张',
        professionalTitle: '教授',
        deptId: 2n,
      }),
    );

    expect(clauses).toHaveLength(5);
    expect(clauses).toContainEqual({
      person: { realName: { contains: '张' } },
    });
    expect(clauses).toContainEqual({
      professionalTitle: { contains: '教授' },
    });
    expect(clauses).toContainEqual({ person: { orgUnit: { deptId: 2n } } });
  });

  it('mentorType=external → externalMentor；internal → internalMentor（显式相等，不是补集）', () => {
    expect(
      andClauses(buildMentorSearchWhere({ mentorType: 'external' })),
    ).toContainEqual({ person: { personType: 'externalMentor' } });
    expect(
      andClauses(buildMentorSearchWhere({ mentorType: 'internal' })),
    ).toContainEqual({ person: { personType: 'internalMentor' } });
    // 补集写法会把 student / 其他人员类型也算成 internal——钉死不许回退
    expect(
      andClauses(buildMentorSearchWhere({ mentorType: 'internal' })),
    ).not.toContainEqual({ person: { personType: { not: 'externalMentor' } } });
  });

  it('researchField 是 JSON 数组的精确项匹配（array_contains）', () => {
    expect(
      andClauses(buildMentorSearchWhere({ researchField: '人工智能' })),
    ).toContainEqual({ researchFields: { array_contains: '人工智能' } });
  });

  it('weekday 只认 status=1 且未软删的时段（deletedAt: null 不能省）', () => {
    expect(andClauses(buildMentorSearchWhere({ weekday: 3 }))).toContainEqual({
      timeSlots: { some: { weekday: 3, status: 1, deletedAt: null } },
    });
  });

  it('keyword 的 OR 只覆盖 realName / summary——不含 researchFields（R29）', () => {
    const clauses = andClauses(buildMentorSearchWhere({ keyword: '人工智能' }));
    const keywordClause = clauses.find((clause) => clause.OR !== undefined);
    expect(keywordClause).toBeDefined();

    const or = keywordClause?.OR as Prisma.MentorProfileWhereInput[];
    expect(or).toEqual([
      { person: { realName: { contains: '人工智能' } } },
      { summary: { contains: '人工智能' } },
    ]);
    // 同一字段只留一套口径：方向检索走 researchField 的 array_contains
    expect(or.some((clause) => clause.researchFields !== undefined)).toBe(
      false,
    );
  });

  it('多条件之间是 AND：每个条件各占一个子句，互不吞并', () => {
    const clauses = andClauses(
      buildMentorSearchWhere({
        name: '王',
        mentorType: 'internal',
        researchField: '外国语',
        professionalTitle: '副教授',
        weekday: 5,
        deptId: 1n,
        keyword: '语言',
      }),
    );

    // status + 人员未离场 + 六个筛选 + keyword 的 OR
    expect(clauses).toHaveLength(9);
    expect(clauses[0]).toEqual({ status: 2 });
    expect(clauses[1]).toEqual({ person: { deletedAt: null } });
    expect(
      clauses.filter((clause) => clause.person !== undefined),
    ).toHaveLength(4);
  });
});

describe('MentorSearchMapper', () => {
  const mapper = new MentorSearchMapper(new MentorMapperProvider());

  it('列表项：BIGINT 字符串、姓名 / 学院 / 类型 / 职称 / 方向 / 简介', () => {
    expect(mapper.toItem(row())).toEqual({
      id: '5',
      name: '张明远',
      mentorType: 'internal',
      deptName: '计算机学院',
      professionalTitle: '教授',
      researchFields: ['人工智能', '软件工程'],
      summary: '长期从事人工智能研究。',
    });
  });

  it('详情 = 列表项 + 成果 / 经验 / 合作单位 / 社会任职 / 电话（无学生字段）', () => {
    const detail = mapper.toDetail(
      row({
        affiliateOrg: '某某研究院',
        socialRoles: '某某学会理事',
        person: {
          ...row().person,
          personType: 'externalMentor',
        },
      }),
    );

    expect(detail).toEqual({
      id: '5',
      name: '张明远',
      mentorType: 'external',
      deptName: '计算机学院',
      professionalTitle: '教授',
      researchFields: ['人工智能', '软件工程'],
      summary: '长期从事人工智能研究。',
      researchAchievements: '主持省部级项目 2 项。',
      guidanceExperience: '指导研究生 12 名。',
      affiliateOrg: '某某研究院',
      socialRoles: '某某学会理事',
      mobile: '13800000000',
    });
    expect(Object.keys(detail)).not.toContain('major');
    expect(Object.keys(detail)).not.toContain('className');
  });

  it('researchFields 的坏数据兜底成 []（不把 500 抛给检索页）', () => {
    const item = mapper.toItem(
      row({
        researchFields: { unexpected: 'shape' } as unknown as Prisma.JsonValue,
      }),
    );
    expect(item.researchFields).toEqual([]);
  });
});

describe('MentorSearchService', () => {
  function buildService(
    options: {
      row?: MentorSearchRow | null;
      page?: { rows: MentorSearchRow[]; total: number };
    } = {},
  ): {
    service: MentorSearchService;
    findPage: jest.Mock;
    findApprovedById: jest.Mock;
  } {
    const findPage = jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve(options.page ?? { rows: [], total: 0 }),
      );
    const findApprovedById = jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve(options.row === undefined ? row() : options.row),
      );

    const service = new MentorSearchService(
      { findPage, findApprovedById } as unknown as MentorSearchRepository,
      new MentorSearchMapper(new MentorMapperProvider()),
    );

    return { service, findPage, findApprovedById };
  }

  it('findPage：分页结构透传 page / pageSize，deptId 转成 bigint', async () => {
    const h = buildService({ page: { rows: [row()], total: 1 } });
    const result = await h.service.findPage(
      query({ deptId: '2', page: 2, pageSize: 5 }),
    );

    expect(h.findPage).toHaveBeenCalledWith({
      deptId: 2n,
      page: 2,
      pageSize: 5,
    });
    expect(result).toEqual({
      list: [
        {
          id: '5',
          name: '张明远',
          mentorType: 'internal',
          deptName: '计算机学院',
          professionalTitle: '教授',
          researchFields: ['人工智能', '软件工程'],
          summary: '长期从事人工智能研究。',
        },
      ],
      total: 1,
      page: 2,
      pageSize: 5,
    });
  });

  it('findPage：没传的筛选条件不落进参数（undefined 不参与 AND）', async () => {
    const h = buildService();
    await h.service.findPage(query());

    expect(h.findPage).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
  });

  it('findOne：未生效 / 不存在 → 404 / 31102', async () => {
    const h = buildService({ row: null });
    const error = await captureError(h.service.findOne(99n));

    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.MENTOR_PROFILE_NOT_FOUND,
      message: '导师专业档案不存在',
    });
    expect(h.findApprovedById).toHaveBeenCalledWith(99n);
  });

  it('findOne：命中 → 详情 DTO（含 mobile）', async () => {
    const h = buildService();
    const detail = await h.service.findOne(5n);

    expect(detail).toMatchObject({
      id: '5',
      name: '张明远',
      mobile: '13800000000',
      researchAchievements: '主持省部级项目 2 项。',
    });
  });
});
