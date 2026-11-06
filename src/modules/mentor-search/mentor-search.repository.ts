import { Injectable } from '@nestjs/common';
import type {
  MentorProfile,
  MentorTimeSlot,
  Prisma,
  SyncOrgUnit,
  SyncPerson,
} from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { MENTOR_PROFILE_STATUS } from '../mentor/dto/mentor-profile.dto';
import type { MentorSearchType } from './dto/mentor-search-response.dto';

/** 开放时段的 `status`（MentorTimeSlot.status：0 关闭 / 1 开放，同 Task 21） */
const SLOT_OPEN_STATUS = 1;

/** 检索条件（已从 query DTO 转好：`deptId` 已是 bigint） */
export interface MentorSearchParams {
  name?: string;
  mentorType?: MentorSearchType;
  researchField?: string;
  professionalTitle?: string;
  weekday?: number;
  deptId?: bigint;
  keyword?: string;
  page: number;
  pageSize: number;
}

/** 检索行：档案 + 归属人 + 归属人的组织投影（展示姓名 / 类型 / 所属单位用） */
export type MentorSearchRow = MentorProfile & {
  person: SyncPerson & { orgUnit: SyncOrgUnit };
};

/** 详情行：检索行 + 当前开放的时段（列表不带，只有详情带） */
export type MentorSearchDetailRow = MentorSearchRow & {
  timeSlots: MentorTimeSlot[];
};

/**
 * 检索的 where。**抽成纯函数是为了能钉住条件的形状**（同
 * `buildApplicationListWhere` / `buildUserListWhere` 的理由）：六个筛选条件
 * 里有三处落到 `person` 这同一个键上（姓名 / 类型 / 学院），用对象展开合并时
 * 后写的会静默吃掉先写的，而「查不出人」与「条件就是这么窄」在结果上一样。
 *
 * 多条件之间是 **AND**（计划 §Task 22 逐字）：`status=2` 与「人员未离场」是
 * **恒有**的两条，其余条件按传参追加。
 */
export function buildMentorSearchWhere(
  params: Omit<MentorSearchParams, 'page' | 'pageSize'>,
): Prisma.MentorProfileWhereInput {
  const keyword = params.keyword;
  const clauses: Prisma.MentorProfileWhereInput[] = [
    // 只出已生效档案（status = 2 APPROVED）——其余状态一律查不到
    { status: MENTOR_PROFILE_STATUS.APPROVED },
    // 已离场的人不再出现在检索里（需求 §6.4「移出」）：档案还是 status=2，
    // 但 SyncPerson 已软删。软删扩展只过滤顶层模型，**关系过滤不代劳**，
    // 这条不写，离场导师会一直躺在检索结果里。
    { person: { deletedAt: null } },
    ...(params.name === undefined
      ? []
      : [{ person: { realName: { contains: params.name } } }]),
    // 类型**显式枚举**，不用补集：`!= 'externalMentor'` 会把 student / 其他
    // 人员类型也算成 internal，人员类型一扩就错。`teacher` 是同步源来的教师，
    // 与 `internalMentor` 同属校内。
    ...(params.mentorType === undefined
      ? []
      : [
          {
            person: {
              personType:
                params.mentorType === 'external'
                  ? 'externalMentor'
                  : { in: ['internalMentor', 'teacher'] },
            },
          },
        ]),
    // 指导方向：JSON 数组**精确项**匹配（array_contains），不是子串
    ...(params.researchField === undefined
      ? []
      : [{ researchFields: { array_contains: params.researchField } }]),
    ...(params.professionalTitle === undefined
      ? []
      : [
          {
            professionalTitle: { contains: params.professionalTitle },
          },
        ]),
    // 可指导时段：该周几有**开放且未软删**的时段。
    // `deletedAt: null` 不能省——软删扩展只过滤顶层模型，嵌套关系过滤不代劳
    // （prisma.extension.ts），漏了会让已软删的时段把导师「复活」进结果。
    ...(params.weekday === undefined
      ? []
      : [
          {
            timeSlots: {
              some: {
                weekday: params.weekday,
                status: SLOT_OPEN_STATUS,
                deletedAt: null,
              },
            },
          },
        ]),
    ...(params.deptId === undefined
      ? []
      : [{ person: { orgUnit: { deptId: params.deptId } } }]),
    // keyword 只匹配姓名 / 简介（R29）。**不匹配 researchFields**：JSON 数组的
    // 模糊匹配在 Prisma 里只能按下标展开（`path: '$[i]'`），上限是一个手写常量，
    // 超出就静默漏检；方向检索走 `researchField` 的精确项匹配（array_contains），
    // 同一字段只留一套口径。
    ...(keyword === undefined
      ? []
      : [
          {
            OR: [
              { person: { realName: { contains: keyword } } },
              { summary: { contains: keyword } },
            ],
          },
        ]),
  ];

  return { AND: clauses };
}

/**
 * 导师检索的数据访问（Task 22，学生侧只读）。
 *
 * 只读 `MentorProfile` / `SyncPerson` / `SyncOrgUnit`，**一条写路径都没有**：
 * 本模块不建预约、不改档案，也不碰时段。`MentorProfile` 在
 * `SOFT_DELETE_MODELS` 里，顶层读天然滤掉已软删行。
 *
 * 读一律 `findFirst` / `findMany`（ESLint 禁 `findUnique`：软删表塞不进
 * `deletedAt` 过滤）。
 */
@Injectable()
export class MentorSearchRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 分页检索：total 与当前页并行取，排序按档案 ID 升序（稳定分页） */
  async findPage(
    params: MentorSearchParams,
  ): Promise<{ rows: MentorSearchRow[]; total: number }> {
    const where = buildMentorSearchWhere(params);

    const [total, rows] = await Promise.all([
      this.prisma.client.mentorProfile.count({ where }),
      this.prisma.client.mentorProfile.findMany({
        where,
        include: { person: { include: { orgUnit: true } } },
        orderBy: [{ id: 'asc' }],
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
    ]);

    return { rows, total };
  }

  /**
   * 详情：**未生效（status ≠ 2）/ 不存在 / 已软删 / 人员已离场一律 null**——
   * 调用方统一 404 / 31102，不区分「没有」与「还没批」，学生侧不需要知道审核状态。
   */
  async findApprovedById(id: bigint): Promise<MentorSearchDetailRow | null> {
    return this.prisma.client.mentorProfile.findFirst({
      where: {
        id,
        status: MENTOR_PROFILE_STATUS.APPROVED,
        person: { deletedAt: null },
      },
      include: {
        person: { include: { orgUnit: true } },
        // 只要「开放 + 未软删」：关闭的时段不可约，软删的更不能出现在学生端。
        // 嵌套关系过滤不会被软删扩展代劳，`deletedAt: null` 必须显式写。
        timeSlots: {
          where: { status: SLOT_OPEN_STATUS, deletedAt: null },
          orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }, { id: 'asc' }],
        },
      },
    });
  }
}
