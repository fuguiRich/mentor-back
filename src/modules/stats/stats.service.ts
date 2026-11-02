import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ErrorCode } from '../../common/constants/error-code';
import {
  currentDataScopeCeiling,
  type RequestUser,
} from '../../common/context/request-context';
import { BusinessException } from '../../common/errors/business.exception';
import { ConfigService as SysConfigService } from '../config/config.service';
import { DataScopeService } from '../data-scope/data-scope.service';
import { UserService } from '../user/user.service';
import { periodRange } from '../assessment/assessment.metrics';
import { currentPeriod } from '../assessment/assessment.constants';
import type { AppointmentStatsResponseDto } from './dto/appointment-stats.dto';
import type { AssessmentStatsResponseDto } from './dto/assessment-stats.dto';
import type { WorkbenchResponseDto } from './dto/workbench.dto';
import type { GuidanceStatsResponseDto } from './dto/guidance-stats.dto';
import type { MentorStatsResponseDto } from './dto/mentor-stats.dto';
import type { StatsQueryDto } from './dto/stats-query.dto';
import { csvFilename, toCellText } from './export/csv.writer';
import { StatsRepository, toFieldArray } from './stats.repository';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 导师档案状态：0 草稿 / 1 待审核 / 2 已生效 / 3 已驳回 / 4 已冻结 / 5 已移除 */
const STATUS_KEYS = [
  ['draft', 0],
  ['pending', 1],
  ['approved', 2],
  ['rejected', 3],
  ['frozen', 4],
  ['removed', 5],
] as const;

const STATUS_APPROVED = 2;

/** 预约状态：10 个必须全列（缺项补 0） */
const APPOINTMENT_STATUSES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
const APPT_COMPLETED = 6;
/** 「导师接了」的口径：`1..6` 都算（R63） */
const APPT_ACCEPTED_STATUSES = [1, 2, 3, 4, 5, 6] as const;
/** 「已经有结论」的口径：终态 6/7/8/9（R63 的分母） */
const APPT_TERMINAL_STATUSES = [6, 7, 8, 9] as const;
/** 「失败」的口径：拒绝 / 取消 / 过期 */
const APPT_FAILED_STATUSES = [7, 8, 9] as const;

/** `SysConfig` 键：一对师生失败多少次进「线下协调」名单（§5.3） */
const FAILED_PAIR_THRESHOLD_CODE = 'stats.failed_pair_threshold';
const DEFAULT_FAILED_PAIR_THRESHOLD = 3;
const FAILED_PAIR_LIMIT = 50;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 一份待写出的 CSV（表头 + 行 + 文件名） */
export interface ExportPayload {
  filename: string;
  header: string[];
  rows: unknown[][];
}

const EXPORT_MAX_ROWS_CODE = 'export.max_rows';
const DEFAULT_EXPORT_MAX_ROWS = 50000;

const MENTOR_STATUS_LABELS: Record<number, string> = {
  0: '草稿',
  1: '待审核',
  2: '已生效',
  3: '已驳回',
  4: '已冻结',
  5: '已移除',
};

const APPOINTMENT_STATUS_LABELS: Record<number, string> = {
  0: '待确认',
  1: '已确认',
  2: '指导中',
  3: '待学生确认',
  4: '学生已确认',
  5: '有异议',
  6: '已完成',
  7: '已拒绝',
  8: '已取消',
  9: '已过期',
};

const APPOINTMENT_TYPE_LABELS: Record<number, string> = {
  1: '双创竞赛指导',
  2: '科研项目指导',
  3: '创业实践指导',
  4: '论文专利指导',
  5: '其他双创指导',
};

const GRADE_LABELS: Record<number, string> = {
  1: '优秀',
  2: '合格',
  3: '不合格',
};

interface GradeCounts {
  excellent: number;
  qualified: number;
  unqualified: number;
  total: number;
}

type GradeBucket = 'excellent' | 'qualified' | 'unqualified';

/** 1 优秀 / 2 合格 / 3 不合格；其余（含 null）→ null（不计入任何分布） */
function gradeBucket(grade: number | null): GradeBucket | null {
  if (grade === 1) {
    return 'excellent';
  }
  if (grade === 2) {
    return 'qualified';
  }
  if (grade === 3) {
    return 'unqualified';
  }
  return null;
}

function bump(row: GradeCounts, bucket: GradeBucket): void {
  row[bucket] += 1;
  row.total += 1;
}

/**
 * `byResearchField` 的排序：`count` 倒序，同数按 `field` 的**码元序**升序。
 *
 * 不用 `localeCompare`：它随运行环境的 locale 变化，同一份数据在两个部署上
 * 会给出两个次序，前端做 diff 时会以为数据变了。
 */
function compareFieldCount(
  a: { field: string; count: number },
  b: { field: string; count: number },
): number {
  if (a.count !== b.count) {
    return b.count - a.count;
  }
  if (a.field === b.field) {
    return 0;
  }
  return a.field < b.field ? -1 : 1;
}

/**
 * 统计报表（P4 Task 45 起 / §4.1、§4.2、§4.6、§5.3、§6.3）。
 *
 * 三条口径规则（本域全局）：
 * 1. **空集不返回 0**：均值 / 比率类字段在分母为 0 时返回 `null`，计数类返回 `0`；
 * 2. **缺项补 0**：状态分布必须列全，前端直接按它画图；
 * 3. **只算未删行**：一律走 `prisma.client`（软删扩展已生效）。
 */
@Injectable()
export class StatsService {
  constructor(
    private readonly repository: StatsRepository,
    private readonly dataScope: DataScopeService,
    private readonly users: UserService,
    private readonly sysConfig: SysConfigService,
  ) {}

  /**
   * `GET /stats/mentors`（§4.1）。
   *
   * `total` / `internal` / `external` / `active` / `inactive` 只算**生效档案**；
   * `byStatus` 是全部 6 个状态的全量分布。两组口径不同，见 DTO 的说明。
   */
  async mentorStats(
    query: StatsQueryDto,
    caller: RequestUser,
  ): Promise<MentorStatsResponseDto> {
    const { from, to } = resolveRange(query);
    const base = await this.buildProfileBase(query, caller);

    const byStatusMap = await this.repository.countByStatus(base);
    const total = byStatusMap.get(STATUS_APPROVED) ?? 0;
    const [internal, external, active, approvedIds] = await Promise.all([
      this.repository.countApprovedByPersonType(base, 'internalMentor'),
      this.repository.countApprovedByPersonType(base, 'externalMentor'),
      this.repository.countActive(base, from, to),
      this.repository.findApprovedIds(base),
    ]);

    const byStatus = {} as MentorStatsResponseDto['byStatus'];
    for (const [key, status] of STATUS_KEYS) {
      byStatus[key] = byStatusMap.get(status) ?? 0;
    }

    return {
      total,
      internal,
      external,
      active,
      inactive: total - active,
      byStatus,
      byResearchField: await this.tallyResearchFields(approvedIds),
    };
  }

  /**
   * `GET /stats/appointments`（§4.2 / §5.3）。
   *
   * **按导师所在部门统计**（本院的导师收到的预约），不是按申请人部门——
   * §4.2 是导师管理视角（「本院导师的对接情况」），按申请人算会混进别院的学生。
   *
   * 时间维度用 `createdAt`（预约发起时间）：§4.2 问的是「这段时间有多少人来约」，
   * 不是「这段时间约在什么时候」。
   */
  async appointmentStats(
    query: StatsQueryDto,
    caller: RequestUser,
  ): Promise<AppointmentStatsResponseDto> {
    const { from, to } = resolveRange(query);
    const base = await this.buildAppointmentBase(query, caller);
    const scoped: Prisma.AppointmentWhereInput = {
      ...base,
      createdAt: { gte: from, lt: to },
    };

    const [byStatusMap, total, accepted, terminal] = await Promise.all([
      this.repository.countAppointmentsByStatus(scoped),
      this.repository.countAppointments(scoped),
      this.repository.countAppointmentsInStatuses(
        scoped,
        APPT_ACCEPTED_STATUSES,
      ),
      this.repository.countAppointmentsInStatuses(
        scoped,
        APPT_TERMINAL_STATUSES,
      ),
    ]);
    const completed = byStatusMap.get(APPT_COMPLETED) ?? 0;

    const threshold = Math.max(
      1,
      await this.sysConfig.getNumber(
        FAILED_PAIR_THRESHOLD_CODE,
        DEFAULT_FAILED_PAIR_THRESHOLD,
      ),
    );
    const pairs = (
      await this.repository.findFailedPairCounts(scoped, APPT_FAILED_STATUSES)
    )
      .filter((pair) => pair.count >= threshold)
      .sort((a, b) => b.count - a.count)
      .slice(0, FAILED_PAIR_LIMIT);

    const [studentNames, mentorNames] = await Promise.all([
      this.repository.findPersonNames(
        pairs.map((pair) => pair.studentPersonId),
      ),
      this.repository.findMentorNames(
        pairs.map((pair) => pair.mentorProfileId),
      ),
    ]);

    return {
      total,
      byStatus: APPOINTMENT_STATUSES.map((status) => ({
        status,
        count: byStatusMap.get(status) ?? 0,
      })),
      // 分母为 0 → null（不是 0）：把「没有预约」显示成「成功率 0%」是假话
      acceptanceRate: total === 0 ? null : round2(accepted / total),
      completionRate: terminal === 0 ? null : round2(completed / terminal),
      failedPairs: pairs.map((pair) => ({
        studentPersonId: pair.studentPersonId.toString(),
        studentName: studentNames.get(pair.studentPersonId.toString()) ?? '',
        mentorProfileId: pair.mentorProfileId.toString(),
        mentorName: mentorNames.get(pair.mentorProfileId.toString()) ?? '',
        failedCount: pair.count,
      })),
    };
  }

  /**
   * `GET /stats/guidance`（§4.6 / §3.7）。
   *
   * 顶层 5 个合计与 `byType` 是**全量口径**，`byMentor` 只是分页明细。
   * 口径与 P3 的考核指标完全一致（`appointment.status = 6` + `actualTime ∈ 区间`），
   * 两处对同一条数据必须给出同一个数——这是 Task 38 就定下的。
   */
  async guidanceStats(
    query: StatsQueryDto,
    caller: RequestUser,
  ): Promise<GuidanceStatsResponseDto> {
    const { from, to } = resolveRange(query);
    const scope = await this.resolveGuidanceScope(query, caller);
    const type = query.type;

    const appointmentScope: Prisma.AppointmentWhereInput = {
      status: APPT_COMPLETED,
      ...(scope.mentorId === null ? {} : { mentorProfileId: scope.mentorId }),
      ...(scope.deptIds === null
        ? {}
        : {
            mentor: {
              person: { orgUnit: { deptId: { in: scope.deptIds } } },
            },
          }),
    };
    const guidanceWhere = (
      withType?: number,
    ): Prisma.GuidanceRecordWhereInput => ({
      appointment: {
        ...appointmentScope,
        ...(withType === undefined ? {} : { type: withType }),
      },
      actualTime: { gte: from, lt: to },
    });

    const [totals, studentCount, achievementCount] = await Promise.all([
      this.repository.aggregateGuidance(guidanceWhere(type)),
      this.repository.countGuidanceStudents({
        ...appointmentScope,
        guidanceRecords: { some: { actualTime: { gte: from, lt: to } } },
      }),
      this.repository.countAchievements({
        awardedAt: { gte: from, lt: to },
        mentor: {
          status: STATUS_APPROVED,
          ...(scope.mentorId === null ? {} : { id: scope.mentorId }),
          ...(scope.deptIds === null
            ? {}
            : { person: { orgUnit: { deptId: { in: scope.deptIds } } } }),
        },
      }),
    ]);

    const byType = await Promise.all(
      [1, 2, 3, 4, 5].map(async (appointmentType) => {
        const agg = await this.repository.aggregateGuidance(
          guidanceWhere(appointmentType),
        );
        return {
          type: appointmentType,
          count: agg.count,
          minutes: agg.minutes,
        };
      }),
    );

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const mentorWhere: Prisma.MentorProfileWhereInput = {
      status: STATUS_APPROVED,
      ...(scope.mentorId === null ? {} : { id: scope.mentorId }),
      ...(scope.deptIds === null
        ? {}
        : { person: { orgUnit: { deptId: { in: scope.deptIds } } } }),
      appointments: {
        some: {
          status: APPT_COMPLETED,
          ...(type === undefined ? {} : { type }),
          guidanceRecords: { some: { actualTime: { gte: from, lt: to } } },
        },
      },
    };
    const [mentors, byMentorTotal] =
      await this.repository.findGuidanceMentorPage(
        mentorWhere,
        (page - 1) * pageSize,
        pageSize,
      );
    const mentorIds = mentors.map((mentor) => mentor.id);
    const [guidanceByMentor, achievementsByMentor] = await Promise.all([
      this.repository.tallyGuidanceByMentor(mentorIds, from, to, type),
      this.repository.tallyAchievementsByMentor(mentorIds, from, to),
    ]);

    return {
      guidanceCount: totals.count,
      guidanceMinutes: totals.minutes,
      studentCount,
      achievementCount,
      byType,
      byMentor: mentors.map((mentor) => {
        const key = mentor.id.toString();
        const tally = guidanceByMentor.get(key);
        return {
          mentorProfileId: key,
          mentorName: mentor.person.realName,
          guidanceCount: tally?.count ?? 0,
          guidanceMinutes: tally?.minutes ?? 0,
          studentCount: tally?.students ?? 0,
          achievementCount: achievementsByMentor.get(key) ?? 0,
        };
      }),
      byMentorTotal,
      page,
      pageSize,
    };
  }

  /**
   * 指导统计的范围：`self` 只放本人（导师看自己的台账），`dept` 本院，`all` 全校。
   *
   * `self` 时如果传了别人的 `mentorId` → **403 / 10003**，不是静默改成自己：
   * 静默改会让前端以为「查到了」。
   */
  private async resolveGuidanceScope(
    query: StatsQueryDto,
    caller: RequestUser,
  ): Promise<{ mentorId: bigint | null; deptIds: bigint[] | null }> {
    const user = await this.users.findById(caller.userId);
    const scope = await this.dataScope.resolve(
      {
        userId: caller.userId,
        isSuperAdmin: caller.isSuperAdmin,
        deptId: user?.deptId ?? null,
      },
      currentDataScopeCeiling(),
    );

    const requested =
      query.mentorId === undefined ? null : BigInt(query.mentorId);

    if (query.deptId !== undefined) {
      if (scope.kind !== 'all') {
        throw this.forbidden();
      }
      if (requested !== null) {
        throw this.forbidden();
      }
      return { mentorId: null, deptIds: [BigInt(query.deptId)] };
    }
    if (scope.kind === 'all') {
      return { mentorId: requested, deptIds: null };
    }
    if (scope.kind === 'depts') {
      return { mentorId: requested, deptIds: scope.deptIds };
    }

    // self：只放本人
    const person =
      user === null
        ? null
        : await this.repository.findPersonByLogin(user.username);
    const own =
      person === null
        ? null
        : await this.repository.findProfileByPersonId(person.id);
    if (requested !== null && requested !== own?.id) {
      throw this.forbidden();
    }
    return { mentorId: own?.id ?? -1n, deptIds: null };
  }

  /**
   * `GET /stats/assessments`（§6.3 / §6.8）。
   *
   * **`period` 必填**：考核分布脱离周期没有意义（同一导师每年一条）。
   * **只统计 `status = 2 APPROVED`**：未终评的没有等级，算进来会让
   * 「不合格率」随时间自己变化。
   *
   * 三个分布的分母口径：`byDept` / `byMentorType` 各行 `total` 之和 = `total`；
   * `byResearchField` 的会**大于** `total`——一个导师多个方向时在每个方向各计一次。
   */
  async assessmentStats(
    query: StatsQueryDto,
    caller: RequestUser,
  ): Promise<AssessmentStatsResponseDto> {
    if (query.period === undefined) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        'period 必填',
        HttpStatus.BAD_REQUEST,
      );
    }
    const base = await this.buildAssessmentBase(query, caller);
    const rows = await this.repository.findApprovedAssessments(base);

    const byGrade = { excellent: 0, qualified: 0, unqualified: 0 };
    const byDept = new Map<
      string,
      { deptId: string | null; deptName: string } & GradeCounts
    >();
    const byType = new Map<
      'internal' | 'external',
      { mentorType: 'internal' | 'external' } & GradeCounts
    >();
    const byField = new Map<string, { field: string } & GradeCounts>();
    let total = 0;

    for (const row of rows) {
      const bucket = gradeBucket(row.finalGrade);
      if (bucket === null) {
        // 已生效却没有等级：数据被手工改过。跳过而不是抛——
        // 读接口不该因为一行脏数据整个 500
        continue;
      }
      total += 1;
      byGrade[bucket] += 1;

      const orgUnit = row.mentor.person.orgUnit;
      const deptId = orgUnit?.deptId ?? null;
      const deptKey = deptId === null ? 'none' : deptId.toString();
      const deptRow = byDept.get(deptKey) ?? {
        deptId: deptId === null ? null : deptId.toString(),
        deptName: orgUnit?.name ?? '未分配',
        excellent: 0,
        qualified: 0,
        unqualified: 0,
        total: 0,
      };
      bump(deptRow, bucket);
      byDept.set(deptKey, deptRow);

      const mentorType =
        row.mentor.person.personType === 'externalMentor'
          ? ('external' as const)
          : ('internal' as const);
      const typeRow = byType.get(mentorType) ?? {
        mentorType,
        excellent: 0,
        qualified: 0,
        unqualified: 0,
        total: 0,
      };
      bump(typeRow, bucket);
      byType.set(mentorType, typeRow);

      for (const field of new Set(toFieldArray(row.mentor.researchFields))) {
        const fieldRow = byField.get(field) ?? {
          field,
          excellent: 0,
          qualified: 0,
          unqualified: 0,
          total: 0,
        };
        bump(fieldRow, bucket);
        byField.set(field, fieldRow);
      }
    }

    return {
      total,
      byGrade,
      byDept: [...byDept.values()].sort((a, b) =>
        a.deptName < b.deptName ? -1 : 1,
      ),
      byMentorType: [...byType.values()].sort((a, b) =>
        a.mentorType < b.mentorType ? -1 : 1,
      ),
      byResearchField: [...byField.values()].sort((a, b) =>
        b.total !== a.total ? b.total - a.total : a.field < b.field ? -1 : 1,
      ),
    };
  }

  /**
   * `GET /mentors/:mentorId/workbench`（§3.6 导师个人工作台）。
   *
   * **全部实时值**：工作台回答「现在怎么样」，考核详情回答「提交时是什么样」。
   * 三个预约计数只算该导师的；`reviewSummary` 与评价列表的 `summary` 同源同口径。
   */
  async workbench(
    mentorId: bigint,
    caller: RequestUser,
  ): Promise<WorkbenchResponseDto> {
    const profile = await this.repository.findProfileWithDept(mentorId);
    if (profile === null) {
      throw this.mentorNotFound();
    }
    await this.assertMentorVisible(profile, caller);

    const [statusMap, reviews, assessment, archivedCount] = await Promise.all([
      this.repository.countAppointmentsByStatus({ mentorProfileId: mentorId }),
      this.repository.aggregateReviews(mentorId),
      this.repository.findAssessmentByMentorPeriod(mentorId, currentPeriod()),
      this.repository.countArchived(mentorId),
    ]);

    return {
      pendingAppointments: statusMap.get(0) ?? 0,
      confirmedAppointments: statusMap.get(1) ?? 0,
      awaitingStudentConfirm: statusMap.get(3) ?? 0,
      reviewSummary: {
        count: reviews.count,
        avg: reviews.overall === null ? null : round2(reviews.overall),
        attitudeAvg:
          reviews.attitude === null ? null : round2(reviews.attitude),
        expertiseAvg:
          reviews.expertise === null ? null : round2(reviews.expertise),
        effectAvg: reviews.effect === null ? null : round2(reviews.effect),
      },
      currentAssessment:
        assessment === null
          ? null
          : {
              id: assessment.id.toString(),
              period: assessment.period,
              status: assessment.status,
              collegeGrade: assessment.collegeGrade,
              finalGrade: assessment.finalGrade,
              compositeScore:
                assessment.compositeScore === null
                  ? null
                  : Number(assessment.compositeScore).toFixed(2),
            },
      archivedCount,
    };
  }

  /** 工作台的可见性：导师本人 / 覆盖其所在部门的管理员；其余 403 / 10003 */
  private async assertMentorVisible(
    profile: {
      personId: bigint;
      person: { orgUnit: { deptId: bigint | null } | null };
    },
    caller: RequestUser,
  ): Promise<void> {
    const user = await this.users.findById(caller.userId);
    const scope = await this.dataScope.resolve(
      {
        userId: caller.userId,
        isSuperAdmin: caller.isSuperAdmin,
        deptId: user?.deptId ?? null,
      },
      currentDataScopeCeiling(),
    );
    if (scope.kind === 'all') {
      return;
    }
    if (scope.kind === 'self') {
      const person =
        user === null
          ? null
          : await this.repository.findPersonByLogin(user.username);
      if (person !== null && person.id === profile.personId) {
        return;
      }
      throw this.forbidden();
    }
    const deptId = profile.person.orgUnit?.deptId ?? null;
    if (deptId !== null && scope.deptIds.some((id) => id === deptId)) {
      return;
    }
    throw this.forbidden();
  }

  private mentorNotFound(): BusinessException {
    return new BusinessException(
      ErrorCode.MENTOR_PROFILE_NOT_FOUND,
      '导师专业档案不存在',
      HttpStatus.NOT_FOUND,
    );
  }

  // ── 导出（Task 50）───────────────────────────────────────────────

  async exportMentors(
    query: StatsQueryDto,
    caller: RequestUser,
  ): Promise<ExportPayload> {
    const maxRows = await this.maxRows();
    const deptIds = await this.resolveExportDeptIds(query, caller);
    const rows = await this.repository.findMentorExportRows(deptIds, maxRows);
    this.assertWithinLimit(rows.length, maxRows);
    return {
      filename: csvFilename('mentor-list', query.period ?? 'all'),
      header: [
        '工号',
        '姓名',
        '导师类型',
        '所属学院',
        '职称',
        '指导方向',
        '档案状态',
        '入驻时间',
      ],
      rows: rows.map((row) => {
        const person = row.person as {
          login: string;
          realName: string;
          personType: string;
          orgUnit: { name: string } | null;
        };
        return [
          person.login,
          person.realName,
          person.personType === 'externalMentor' ? '校外' : '校内',
          person.orgUnit?.name ?? '',
          toCellText(row.professionalTitle),
          toFieldArray(row.researchFields).join('/'),
          MENTOR_STATUS_LABELS[row.status as number] ?? String(row.status),
          row.createdAt,
        ];
      }),
    };
  }

  async exportAppointments(
    query: StatsQueryDto,
    caller: RequestUser,
  ): Promise<ExportPayload> {
    const { from, to } = resolveRange(query);
    const maxRows = await this.maxRows();
    const deptIds = await this.resolveExportDeptIds(query, caller);
    const rows = await this.repository.findAppointmentExportRows(
      deptIds,
      from,
      to,
      maxRows,
    );
    this.assertWithinLimit(rows.length, maxRows);
    return {
      filename: csvFilename('appointment-list', query.period ?? 'all'),
      header: [
        '预约ID',
        '学生学号',
        '学生姓名',
        '导师姓名',
        '预约类型',
        '状态',
        '期望指导时间',
        '发起时间',
      ],
      rows: rows.map((row) => {
        const student = row.student as { login: string; realName: string };
        const mentor = row.mentor as { person: { realName: string } };
        return [
          row.id,
          student.login,
          student.realName,
          mentor.person.realName,
          APPOINTMENT_TYPE_LABELS[row.type as number] ?? String(row.type),
          APPOINTMENT_STATUS_LABELS[row.status as number] ?? String(row.status),
          row.requestedTime,
          row.createdAt,
        ];
      }),
    };
  }

  async exportGuidance(
    query: StatsQueryDto,
    caller: RequestUser,
  ): Promise<ExportPayload> {
    const { from, to } = resolveRange(query);
    const maxRows = await this.maxRows();
    const deptIds = await this.resolveExportDeptIds(query, caller);
    const rows = await this.repository.findGuidanceExportRows(
      deptIds,
      from,
      to,
      maxRows,
    );
    this.assertWithinLimit(rows.length, maxRows);
    // 每行一位导师；次数 / 时长 / 学生数按区间现算，与 `guidanceStats` 同源
    const tally = await this.repository.tallyGuidanceByMentor(
      rows.map((row) => row.id as bigint),
      from,
      to,
      query.type,
    );
    const achievements = await this.repository.tallyAchievementsByMentor(
      rows.map((row) => row.id as bigint),
      from,
      to,
    );
    return {
      filename: csvFilename('guidance-stats', query.period ?? 'all'),
      header: [
        '导师工号',
        '导师姓名',
        '所属学院',
        '指导次数',
        '指导时长(分钟)',
        '指导学生数',
        '成果数',
      ],
      rows: rows.map((row) => {
        const person = row.person as {
          login: string;
          realName: string;
          orgUnit: { name: string } | null;
        };
        const key = (row.id as bigint).toString();
        const stats = tally.get(key);
        return [
          person.login,
          person.realName,
          person.orgUnit?.name ?? '',
          stats?.count ?? 0,
          stats?.minutes ?? 0,
          stats?.students ?? 0,
          achievements.get(key) ?? 0,
        ];
      }),
    };
  }

  async exportAssessments(
    query: StatsQueryDto,
    caller: RequestUser,
  ): Promise<ExportPayload> {
    if (query.period === undefined) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        'period 必填',
        HttpStatus.BAD_REQUEST,
      );
    }
    const maxRows = await this.maxRows();
    const deptIds = await this.resolveExportDeptIds(query, caller);
    const rows = await this.repository.findAssessmentExportRows(
      deptIds,
      query.period,
      maxRows,
    );
    this.assertWithinLimit(rows.length, maxRows);
    return {
      filename: csvFilename('assessment-result', query.period),
      header: [
        '导师工号',
        '导师姓名',
        '所属学院',
        '考核周期',
        '初评等级',
        '终评等级',
        '综合得分',
        '生效时间',
      ],
      rows: rows.map((row) => {
        const mentor = row.mentor as {
          person: {
            login: string;
            realName: string;
            orgUnit: { name: string } | null;
          };
        };
        return [
          mentor.person.login,
          mentor.person.realName,
          mentor.person.orgUnit?.name ?? '',
          row.period,
          GRADE_LABELS[row.collegeGrade as number] ?? '',
          GRADE_LABELS[row.finalGrade as number] ?? '',
          row.compositeScore === null
            ? ''
            : Number(row.compositeScore).toFixed(2),
          row.finalReviewedAt,
        ];
      }),
    };
  }

  /** `GET /me/records/export`（§2.6）：**学生本人的**已完成预约 + 记录 + 我的评价 */
  async exportStudentRecords(caller: RequestUser): Promise<ExportPayload> {
    const maxRows = await this.maxRows();
    const user = await this.users.findById(caller.userId);
    const person =
      user === null
        ? null
        : await this.repository.findPersonByLogin(user.username);
    if (person === null) {
      throw this.forbidden();
    }
    const rows = await this.repository.findStudentRecordExportRows(
      person.id,
      maxRows,
    );
    this.assertWithinLimit(rows.length, maxRows);
    return {
      filename: csvFilename('my-records', 'self'),
      header: [
        '预约ID',
        '导师姓名',
        '预约类型',
        '指导主题',
        '实际指导时间',
        '指导时长(分钟)',
        '我的评分',
        '我的评价',
      ],
      rows: rows.map((row) => {
        const mentor = row.mentor as { person: { realName: string } };
        const records = row.guidanceRecords as Array<{
          actualTime: Date;
          durationMinutes: number;
        }>;
        const reviews = row.reviews as Array<{
          overallScore: { toString(): string };
          comment: string | null;
        }>;
        const record = records[0];
        const review = reviews[0];
        return [
          row.id,
          mentor.person.realName,
          APPOINTMENT_TYPE_LABELS[row.type as number] ?? String(row.type),
          row.topic,
          record === undefined ? '' : record.actualTime,
          record === undefined ? '' : record.durationMinutes,
          review === undefined ? '' : Number(review.overallScore).toFixed(2),
          review === undefined ? '' : (review.comment ?? ''),
        ];
      }),
    };
  }

  private async maxRows(): Promise<number> {
    const configured = await this.sysConfig.getNumber(
      EXPORT_MAX_ROWS_CODE,
      DEFAULT_EXPORT_MAX_ROWS,
    );
    return configured > 0 ? Math.floor(configured) : DEFAULT_EXPORT_MAX_ROWS;
  }

  /** 超过上限 → **409，一个字节都不写**（R62）。不静默截断 */
  private assertWithinLimit(count: number, maxRows: number): void {
    if (count > maxRows) {
      throw new BusinessException(
        ErrorCode.EXPORT_TOO_LARGE,
        '导出结果超过上限，请缩小查询范围',
        HttpStatus.CONFLICT,
      );
    }
  }

  /**
   * 导出的部门范围。**`self` 直接 403**：这些是名单类导出，
   * 导师 / 学生不该导出全院名单；各自的个人数据走 `/me/records/export`。
   */
  private async resolveExportDeptIds(
    query: StatsQueryDto,
    caller: RequestUser,
  ): Promise<bigint[] | null> {
    const user = await this.users.findById(caller.userId);
    const scope = await this.dataScope.resolve(
      {
        userId: caller.userId,
        isSuperAdmin: caller.isSuperAdmin,
        deptId: user?.deptId ?? null,
      },
      currentDataScopeCeiling(),
    );
    if (query.deptId !== undefined) {
      if (scope.kind !== 'all') {
        throw this.forbidden();
      }
      return [BigInt(query.deptId)];
    }
    if (scope.kind === 'all') {
      return null;
    }
    if (scope.kind === 'depts') {
      return scope.deptIds;
    }
    throw this.forbidden();
  }

  /** 考核统计的 where：按**导师所在部门**收窄（`deptId` 只有 `all` 能传） */
  private async buildAssessmentBase(
    query: StatsQueryDto,
    caller: RequestUser,
  ): Promise<Prisma.AssessmentWhereInput> {
    const user = await this.users.findById(caller.userId);
    const scope = await this.dataScope.resolve(
      {
        userId: caller.userId,
        isSuperAdmin: caller.isSuperAdmin,
        deptId: user?.deptId ?? null,
      },
      currentDataScopeCeiling(),
    );

    const where: Prisma.AssessmentWhereInput = { period: query.period };
    if (query.deptId !== undefined) {
      if (scope.kind !== 'all') {
        throw this.forbidden();
      }
      where.mentor = {
        person: { orgUnit: { deptId: BigInt(query.deptId) } },
      };
    } else if (scope.kind === 'depts') {
      where.mentor = {
        person: { orgUnit: { deptId: { in: scope.deptIds } } },
      };
    } else if (scope.kind === 'self') {
      where.id = -1n;
    }
    return where;
  }

  /** 预约统计的 where：按**导师所在部门**收窄（`deptId` 只有 `all` 能传） */
  private async buildAppointmentBase(
    query: StatsQueryDto,
    caller: RequestUser,
  ): Promise<Prisma.AppointmentWhereInput> {
    const user = await this.users.findById(caller.userId);
    const scope = await this.dataScope.resolve(
      {
        userId: caller.userId,
        isSuperAdmin: caller.isSuperAdmin,
        deptId: user?.deptId ?? null,
      },
      currentDataScopeCeiling(),
    );

    if (query.deptId !== undefined) {
      if (scope.kind !== 'all') {
        throw this.forbidden();
      }
      return {
        mentor: {
          person: { orgUnit: { deptId: BigInt(query.deptId) } },
        },
      };
    }
    if (scope.kind === 'depts') {
      return {
        mentor: { person: { orgUnit: { deptId: { in: scope.deptIds } } } },
      };
    }
    if (scope.kind === 'self') {
      return { id: -1n };
    }
    return {};
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  /**
   * 指导方向分布（R67）：应用层聚合，**同一导师的重复方向只计一次**。
   *
   * 排序：`count` 倒序，同数按 `field` 升序——不确定的次序会让同一份数据
   * 两次请求给出两个列表，前端做 diff 时会以为数据变了。
   */
  private async tallyResearchFields(
    mentorIds: bigint[],
  ): Promise<{ field: string; count: number }[]> {
    const fields = await this.repository.loadResearchFields(mentorIds);
    const tally = new Map<string, number>();
    for (const list of fields.values()) {
      for (const field of new Set(list)) {
        tally.set(field, (tally.get(field) ?? 0) + 1);
      }
    }
    return [...tally.entries()]
      .map(([field, count]) => ({ field, count }))
      .sort(compareFieldCount);
  }

  /**
   * 档案的 where 片段：先按查询参数（类型），再按调用者的有效数据范围收窄。
   *
   * `deptId` 只有 `all` 范围能传——学院管理员传了就是越权指定范围，
   * 直接 **403 / 10003**，不是静默忽略。
   */
  private async buildProfileBase(
    query: StatsQueryDto,
    caller: RequestUser,
  ): Promise<Prisma.MentorProfileWhereInput> {
    const person: Prisma.SyncPersonWhereInput = {};
    if (query.mentorType !== undefined) {
      person.personType =
        query.mentorType === 'internal' ? 'internalMentor' : 'externalMentor';
    }

    const user = await this.users.findById(caller.userId);
    const scope = await this.dataScope.resolve(
      {
        userId: caller.userId,
        isSuperAdmin: caller.isSuperAdmin,
        deptId: user?.deptId ?? null,
      },
      currentDataScopeCeiling(),
    );

    if (query.deptId !== undefined) {
      if (scope.kind !== 'all') {
        throw this.forbidden();
      }
      person.orgUnit = { deptId: BigInt(query.deptId) };
    } else if (scope.kind === 'depts') {
      person.orgUnit = { deptId: { in: scope.deptIds } };
    } else if (scope.kind === 'self') {
      // 统计接口只绑管理员，走到这里是配置异常：给一个不可能命中的条件
      return { id: -1n };
    }

    return Object.keys(person).length === 0 ? {} : { person };
  }

  private forbidden(): BusinessException {
    return new BusinessException(
      ErrorCode.FORBIDDEN,
      '无权限',
      HttpStatus.FORBIDDEN,
    );
  }
}

/**
 * 解析统计区间（R70）。
 *
 * - `period` 与 `from`/`to` **互斥**，同时出现 → 400 / 10001；
 * - `from` / `to` 必须**成对**出现，只给一个 → 400（半开区间没有合理的默认另一半）；
 * - `from > to` → 400；
 * - 都不传 → 当前学期。
 *
 * `from` / `to` 是**闭区间**，转成半开 `[from 00:00Z, to+1d 00:00Z)`。
 */
export function resolveRange(query: StatsQueryDto): { from: Date; to: Date } {
  const hasPeriod = query.period !== undefined;
  const hasFrom = query.from !== undefined;
  const hasTo = query.to !== undefined;

  if (hasPeriod && (hasFrom || hasTo)) {
    throw new BusinessException(
      ErrorCode.PARAM_INVALID,
      'period 与 from/to 只能二选一',
      HttpStatus.BAD_REQUEST,
    );
  }
  if (hasFrom !== hasTo) {
    throw new BusinessException(
      ErrorCode.PARAM_INVALID,
      'from 与 to 必须成对出现',
      HttpStatus.BAD_REQUEST,
    );
  }
  if (hasPeriod) {
    return periodRange(query.period as string);
  }
  if (hasFrom && hasTo) {
    const from = new Date(`${query.from}T00:00:00.000Z`);
    const to = new Date(
      new Date(`${query.to}T00:00:00.000Z`).getTime() + DAY_MS,
    );
    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      from >= to
    ) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        'from 必须不晚于 to',
        HttpStatus.BAD_REQUEST,
      );
    }
    return { from, to };
  }
  return periodRange(currentPeriod());
}
