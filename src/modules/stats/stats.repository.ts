import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { APPOINTMENT_STATUS } from '../appointment/dto/create-appointment.dto';

/** 每批读多少条档案（`loadResearchFields` 的分页粒度） */
const RESEARCH_FIELD_BATCH = 500;

/**
 * 统计域的只读数据访问（P4 Task 45 起）。
 *
 * **本类不得有写方法**：统计接口一律只读，写任何表都会让「报表」与「业务」产生
 * 隐藏耦合——报表跑一次改一次数据，是最难查的那类 bug。
 */
@Injectable()
export class StatsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 按状态分组计数（返回 `Map<status, count>`，缺项由调用方补 0） */
  async countByStatus(
    base: Prisma.MentorProfileWhereInput,
  ): Promise<Map<number, number>> {
    const rows = await this.prisma.client.mentorProfile.groupBy({
      by: ['status'],
      where: base,
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.status, row._count._all]));
  }

  countApproved(base: Prisma.MentorProfileWhereInput): Promise<number> {
    return this.prisma.client.mentorProfile.count({
      where: { ...base, status: 2 },
    });
  }

  /** 生效档案里按 `personType` 计数（`internalMentor` / `externalMentor`） */
  countApprovedByPersonType(
    base: Prisma.MentorProfileWhereInput,
    personType: string,
  ): Promise<number> {
    const person: Prisma.SyncPersonWhereInput = { ...base.person };
    // 调用方已经按 `mentorType` 限定过类型时，**不要覆盖**：
    // 问「校外筛选下有多少校内导师」的答案是 0，不是「全部校内导师」。
    if (person.personType !== undefined && person.personType !== personType) {
      return Promise.resolve(0);
    }
    return this.prisma.client.mentorProfile.count({
      // **合并**而不是覆盖 `base.person`：base 里的部门范围就在这个对象上，
      // 直接写 `person: { personType }` 会把部门过滤整个丢掉——
      // 学院管理员会看到全校的校内导师数（而 total 仍是本院的）。
      where: { ...base, status: 2, person: { ...person, personType } },
    });
  }

  /**
   * 活跃导师数（R68）：生效档案在 `[from, to)` 内有 **≥1 条 `status = 6` 的预约**。
   *
   * 用 `appointment.updatedAt` 做时间锚：那是「它变成 6」的时刻，
   * 与 `requestedTime`（约定时间）不是一回事——按约定时间算的话，
   * 一条拖到次年才完成的指导会被算进上一年。
   */
  countActive(
    base: Prisma.MentorProfileWhereInput,
    from: Date,
    to: Date,
  ): Promise<number> {
    return this.prisma.client.mentorProfile.count({
      where: {
        ...base,
        status: 2,
        appointments: {
          some: {
            status: APPOINTMENT_STATUS.COMPLETED,
            updatedAt: { gte: from, lt: to },
          },
        },
      },
    });
  }

  /**
   * 分页读完一批导师的 `researchFields`，返回 `mentorId → 方向数组（已去重）`。
   *
   * **为什么在应用层做**（R67）：该列是 JSON 数组，Prisma 没有「任意下标展开」；
   * `path: '$[i]'` 要写死上限（R29 已裁定不用），`JSON_TABLE` 是裸 SQL
   * （LAYER-09 只放行 `SELECT … FOR UPDATE`）。导师量级是千级，不构成瓶颈。
   */
  async loadResearchFields(
    mentorIds: bigint[],
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    for (let i = 0; i < mentorIds.length; i += RESEARCH_FIELD_BATCH) {
      const batch = mentorIds.slice(i, i + RESEARCH_FIELD_BATCH);
      const rows = await this.prisma.client.mentorProfile.findMany({
        where: { id: { in: batch } },
        select: { id: true, researchFields: true },
      });
      for (const row of rows) {
        result.set(row.id.toString(), toFieldArray(row.researchFields));
      }
    }
    return result;
  }

  // ── 预约统计（Task 46）───────────────────────────────────────────

  async countAppointmentsByStatus(
    where: Prisma.AppointmentWhereInput,
  ): Promise<Map<number, number>> {
    const rows = await this.prisma.client.appointment.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.status, row._count._all]));
  }

  countAppointments(where: Prisma.AppointmentWhereInput): Promise<number> {
    return this.prisma.client.appointment.count({ where });
  }

  /** 某个状态集合的预约数（两个比率的分子 / 分母） */
  countAppointmentsInStatuses(
    where: Prisma.AppointmentWhereInput,
    statuses: readonly number[],
  ): Promise<number> {
    return this.prisma.client.appointment.count({
      where: { ...where, status: { in: [...statuses] } },
    });
  }

  /**
   * 按「学生 × 导师」分组数失败预约（`7 REJECTED` / `8 CANCELLED` / `9 EXPIRED`）。
   *
   * `having` 的写法在 Prisma 里对复合分组不稳定，这里**取回全部分组再在应用层筛**：
   * 有失败预约的师生对是百级量级，不是瓶颈；换来的是确定的行为。
   */
  async findFailedPairCounts(
    where: Prisma.AppointmentWhereInput,
    statuses: readonly number[],
  ): Promise<
    { studentPersonId: bigint; mentorProfileId: bigint; count: number }[]
  > {
    const rows = await this.prisma.client.appointment.groupBy({
      by: ['studentPersonId', 'mentorProfileId'],
      where: { ...where, status: { in: [...statuses] } },
      _count: { _all: true },
    });
    return rows.map((row) => ({
      studentPersonId: row.studentPersonId,
      mentorProfileId: row.mentorProfileId,
      count: row._count._all,
    }));
  }

  /** `SyncPerson.id → realName`（失败名单要显示人名） */
  async findPersonNames(ids: bigint[]): Promise<Map<string, string>> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.prisma.client.syncPerson.findMany({
      where: { id: { in: ids } },
      select: { id: true, realName: true },
    });
    return new Map(rows.map((row) => [row.id.toString(), row.realName]));
  }

  /** `MentorProfile.id → 导师姓名` */
  async findMentorNames(ids: bigint[]): Promise<Map<string, string>> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.prisma.client.mentorProfile.findMany({
      where: { id: { in: ids } },
      select: { id: true, person: { select: { realName: true } } },
    });
    return new Map(rows.map((row) => [row.id.toString(), row.person.realName]));
  }

  // ── 指导统计（Task 47）───────────────────────────────────────────

  async aggregateGuidance(
    where: Prisma.GuidanceRecordWhereInput,
  ): Promise<{ count: number; minutes: number }> {
    const result = await this.prisma.client.guidanceRecord.aggregate({
      where,
      _count: { _all: true },
      _sum: { durationMinutes: true },
    });
    return {
      count: result._count._all,
      minutes: result._sum.durationMinutes ?? 0,
    };
  }

  /** 去重学生数：同一学生指导 3 次只算 1 人 */
  async countGuidanceStudents(
    where: Prisma.AppointmentWhereInput,
  ): Promise<number> {
    const rows = await this.prisma.client.appointment.findMany({
      where,
      select: { studentPersonId: true },
      distinct: ['studentPersonId'],
    });
    return rows.length;
  }

  /** 有指导记录（且在区间内）的导师档案，分页 + 带姓名 */
  findGuidanceMentorPage(
    where: Prisma.MentorProfileWhereInput,
    skip: number,
    take: number,
  ): Promise<[{ id: bigint; person: { realName: string } }[], number]> {
    return Promise.all([
      this.prisma.client.mentorProfile.findMany({
        where,
        select: { id: true, person: { select: { realName: true } } },
        orderBy: { id: 'asc' },
        skip,
        take,
      }),
      this.prisma.client.mentorProfile.count({ where }),
    ]);
  }

  /**
   * 一批导师在区间内的指导量（次数 / 分钟 / 去重学生数）。
   *
   * **一次取回再在应用层聚合**：按导师逐个查会变成「每页 20 × 2 次查询」，
   * 而这一页的数据量本身不大（一页导师一学年的指导记录）。
   */
  async tallyGuidanceByMentor(
    mentorIds: bigint[],
    from: Date,
    to: Date,
    type?: number,
  ): Promise<
    Map<string, { count: number; minutes: number; students: number }>
  > {
    const result = new Map<
      string,
      { count: number; minutes: number; students: Set<string> }
    >();
    if (mentorIds.length === 0) {
      return new Map();
    }
    const rows = await this.prisma.client.guidanceRecord.findMany({
      where: {
        appointment: {
          mentorProfileId: { in: mentorIds },
          status: APPOINTMENT_STATUS.COMPLETED,
          ...(type === undefined ? {} : { type }),
        },
        actualTime: { gte: from, lt: to },
      },
      select: {
        durationMinutes: true,
        appointment: {
          select: { mentorProfileId: true, studentPersonId: true },
        },
      },
    });
    for (const row of rows) {
      const key = row.appointment.mentorProfileId.toString();
      const entry = result.get(key) ?? {
        count: 0,
        minutes: 0,
        students: new Set<string>(),
      };
      entry.count += 1;
      entry.minutes += row.durationMinutes;
      entry.students.add(row.appointment.studentPersonId.toString());
      result.set(key, entry);
    }
    return new Map(
      [...result.entries()].map(([key, entry]) => [
        key,
        {
          count: entry.count,
          minutes: entry.minutes,
          students: entry.students.size,
        },
      ]),
    );
  }

  /** 一批导师在区间内的成果数 */
  async tallyAchievementsByMentor(
    mentorIds: bigint[],
    from: Date,
    to: Date,
  ): Promise<Map<string, number>> {
    if (mentorIds.length === 0) {
      return new Map();
    }
    const rows = await this.prisma.client.achievement.groupBy({
      by: ['mentorId'],
      where: { mentorId: { in: mentorIds }, awardedAt: { gte: from, lt: to } },
      _count: { _all: true },
    });
    return new Map(
      rows.map((row) => [row.mentorId.toString(), row._count._all]),
    );
  }

  // ── 考核分布（Task 48）───────────────────────────────────────────

  /**
   * 已生效（`status = 2`）的考核 + 导师的类型 / 部门 / 指导方向。
   *
   * 一次取回在应用层聚合：一个周期的考核是百级量级，而按学院 / 类型 / 方向
   * 三个维度各做一次 `groupBy` 需要跨三张表，Prisma 的 `groupBy` 表达不了。
   */
  findApprovedAssessments(where: Prisma.AssessmentWhereInput): Promise<
    Array<{
      finalGrade: number | null;
      mentor: {
        researchFields: Prisma.JsonValue;
        person: {
          personType: string;
          orgUnit: { deptId: bigint | null; name: string } | null;
        };
      };
    }>
  > {
    return this.prisma.client.assessment.findMany({
      where: { ...where, status: 2 },
      select: {
        finalGrade: true,
        mentor: {
          select: {
            researchFields: true,
            person: {
              select: {
                personType: true,
                orgUnit: { select: { deptId: true, name: true } },
              },
            },
          },
        },
      },
    });
  }

  // ── 工作台（Task 49）─────────────────────────────────────────────

  /** 评价汇总（`_avg` 无行时为 null，不兜成 0） */
  async aggregateReviews(mentorProfileId: bigint): Promise<{
    count: number;
    overall: number | null;
    attitude: number | null;
    expertise: number | null;
    effect: number | null;
  }> {
    const result = await this.prisma.client.studentReview.aggregate({
      where: { appointment: { mentorProfileId } },
      _count: { _all: true },
      _avg: {
        overallScore: true,
        attitude: true,
        expertise: true,
        effect: true,
      },
    });
    const toNumber = (value: { toString(): string } | null): number | null =>
      value === null ? null : Number(value);
    return {
      count: result._count._all,
      overall: toNumber(result._avg.overallScore),
      attitude: toNumber(result._avg.attitude),
      expertise: toNumber(result._avg.expertise),
      effect: toNumber(result._avg.effect),
    };
  }

  /** 某导师某周期的考核（工作台只看当前学期那一条） */
  findAssessmentByMentorPeriod(
    mentorProfileId: bigint,
    period: string,
  ): Promise<{
    id: bigint;
    period: string;
    status: number;
    collegeGrade: number | null;
    finalGrade: number | null;
    compositeScore: { toString(): string } | null;
  } | null> {
    return this.prisma.client.assessment.findFirst({
      where: { mentorId: mentorProfileId, period },
      select: {
        id: true,
        period: true,
        status: true,
        collegeGrade: true,
        finalGrade: true,
        compositeScore: true,
      },
    });
  }

  countArchived(mentorId: bigint): Promise<number> {
    return this.prisma.client.archiveItem.count({ where: { mentorId } });
  }

  /** 档案 + 其人的组织单元（工作台的可见性判定用） */
  findProfileWithDept(id: bigint): Promise<{
    id: bigint;
    personId: bigint;
    status: number;
    person: { orgUnit: { deptId: bigint | null } | null };
  } | null> {
    return this.prisma.client.mentorProfile.findFirst({
      where: { id },
      select: {
        id: true,
        personId: true,
        status: true,
        person: { select: { orgUnit: { select: { deptId: true } } } },
      },
    });
  }

  countAchievements(where: Prisma.AchievementWhereInput): Promise<number> {
    return this.prisma.client.achievement.count({ where });
  }

  /** 身份链第 2 步：`SysUser.username` → `SyncPerson.login` */
  findPersonByLogin(
    login: string,
  ): Promise<{ id: bigint; realName: string } | null> {
    return this.prisma.client.syncPerson.findFirst({
      where: { login },
      select: { id: true, realName: true },
    });
  }

  /** 身份链第 3 步：`SyncPerson.id` → `MentorProfile` */
  findProfileByPersonId(personId: bigint): Promise<{ id: bigint } | null> {
    return this.prisma.client.mentorProfile.findFirst({
      where: { personId },
      select: { id: true },
    });
  }

  // ── 导出（Task 50）───────────────────────────────────────────────
  //
  // 每个方法都 `take: limit + 1`：多取一条就能判断「超没超上限」，
  // 比先 count 再查少一次往返，而且**判定发生在写响应之前**（R62 的硬要求）。

  findMentorExportRows(
    deptIds: bigint[] | null,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    return this.prisma.client.mentorProfile.findMany({
      where: {
        ...(deptIds === null
          ? {}
          : { person: { orgUnit: { deptId: { in: deptIds } } } }),
      },
      select: {
        status: true,
        professionalTitle: true,
        researchFields: true,
        createdAt: true,
        person: {
          select: {
            login: true,
            realName: true,
            personType: true,
            orgUnit: { select: { name: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
  }

  findAppointmentExportRows(
    deptIds: bigint[] | null,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    return this.prisma.client.appointment.findMany({
      where: {
        createdAt: { gte: from, lt: to },
        ...(deptIds === null
          ? {}
          : { mentor: { person: { orgUnit: { deptId: { in: deptIds } } } } }),
      },
      select: {
        id: true,
        type: true,
        status: true,
        requestedTime: true,
        createdAt: true,
        student: { select: { login: true, realName: true } },
        mentor: { select: { person: { select: { realName: true } } } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
  }

  findGuidanceExportRows(
    deptIds: bigint[] | null,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    return this.prisma.client.mentorProfile.findMany({
      where: {
        // 这里是**导师档案**的状态（2 APPROVED），不是预约的 6 COMPLETED。
        // 两个枚举恰好都叫「已完成」的形状，写混了导出会恒为空表。
        status: 2,
        ...(deptIds === null
          ? {}
          : { person: { orgUnit: { deptId: { in: deptIds } } } }),
        appointments: {
          some: {
            status: APPOINTMENT_STATUS.COMPLETED,
            guidanceRecords: { some: { actualTime: { gte: from, lt: to } } },
          },
        },
      },
      select: {
        id: true,
        person: {
          select: {
            login: true,
            realName: true,
            orgUnit: { select: { name: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
  }

  findAssessmentExportRows(
    deptIds: bigint[] | null,
    period: string,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    return this.prisma.client.assessment.findMany({
      where: {
        period,
        status: 2,
        ...(deptIds === null
          ? {}
          : { mentor: { person: { orgUnit: { deptId: { in: deptIds } } } } }),
      },
      select: {
        period: true,
        collegeGrade: true,
        finalGrade: true,
        compositeScore: true,
        finalReviewedAt: true,
        mentor: {
          select: {
            person: {
              select: {
                login: true,
                realName: true,
                orgUnit: { select: { name: true } },
              },
            },
          },
        },
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
  }

  findStudentRecordExportRows(
    studentPersonId: bigint,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    return this.prisma.client.appointment.findMany({
      where: { studentPersonId, status: APPOINTMENT_STATUS.COMPLETED },
      select: {
        id: true,
        type: true,
        topic: true,
        requestedTime: true,
        mentor: { select: { person: { select: { realName: true } } } },
        guidanceRecords: {
          select: { actualTime: true, durationMinutes: true },
        },
        reviews: { select: { overallScore: true, comment: true } },
      },
      orderBy: [{ requestedTime: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
  }

  /** 生效档案的 id 列表（`byResearchField` 的输入） */
  async findApprovedIds(
    base: Prisma.MentorProfileWhereInput,
  ): Promise<bigint[]> {
    const rows = await this.prisma.client.mentorProfile.findMany({
      where: { ...base, status: 2 },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }
}

/** `Json` 列 → `string[]`：非数组 / 非字符串元素一律丢弃，不抛 */
export function toFieldArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}
