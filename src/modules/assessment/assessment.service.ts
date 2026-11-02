import { HttpStatus, Injectable } from '@nestjs/common';
import type { Assessment, Prisma } from '@prisma/client';
import { ErrorCode } from '../../common/constants/error-code';
import type { RequestUser } from '../../common/context/request-context';
import { isDeptInFilter } from '../../common/constants/data-scope';
import { currentDataScopeCeiling } from '../../common/context/request-context';
import { BusinessException } from '../../common/errors/business.exception';
import { ConfigService as SysConfigService } from '../config/config.service';
import { DataScopeService } from '../data-scope/data-scope.service';
import { UserService } from '../user/user.service';
import {
  ACHIEVEMENT_TARGET_CONFIG_CODE,
  APPEAL_STATUS,
  ASSESSMENT_STATUS,
  DEFAULT_ACHIEVEMENT_TARGET_COUNT,
  DEFAULT_WEIGHTS,
  DEFAULT_WORKLOAD_TARGET_COUNT,
  resolveWeights,
  WEIGHT_CONFIG_CODES,
  WORKLOAD_TARGET_CONFIG_CODE,
  type ResolvedWeights,
} from './assessment.constants';
import {
  computeMetrics,
  type AssessmentMetrics,
  type MetricTargets,
} from './assessment.metrics';
import {
  frozenMetrics,
  frozenWeights,
  toAppealResponse,
  toAssessmentResponse,
} from './assessment.mapper';
import {
  AssessmentRepository,
  type AssessmentWithMentor,
  type CollegeReviewWrite,
  type FinalReviewWrite,
  type ProfileWithDept,
} from './assessment.repository';
import type { CollegeReviewDto } from './dto/college-review.dto';
import type { CreateAssessmentDto } from './dto/create-assessment.dto';
import type { FinalReviewDto } from './dto/final-review.dto';
import type { QueryAssessmentDto } from './dto/query-assessment.dto';
import type { CreateAppealDto } from './dto/create-appeal.dto';
import type { HandleAppealDto } from './dto/handle-appeal.dto';
import type {
  AppealListResponseDto,
  AppealResponseDto,
  QueryAppealDto,
} from './dto/appeal-response.dto';
import type {
  AssessmentListResponseDto,
  AssessmentResponseDto,
} from './dto/assessment-response.dto';
import type {
  AssessmentRuleResponseDto,
  UpdateAssessmentRuleDto,
} from './dto/assessment-rule.dto';

/** 导师档案必须处于「已生效」才可被考核（与检索 / 预约 / 评价同一口径） */
const MENTOR_PROFILE_APPROVED = 2;

/** 可提交初评的出发态：`0 DRAFT` 与 `3 RETURNED`（R53：没有草稿态，退回后可再提交） */
const COLLEGE_REVIEW_FROM_STATUSES = [0, 3] as const;

/**
 * 考核（P3 Task 39 起 / §5.2 初评、§6.2 终评）。
 *
 * 本任务交付两条路由：开考核（`POST /assessments`）与提交初评
 * （`POST /assessments/:id/college-review`）。
 *
 * 三条不变量：
 * 1. **同一导师同一周期只有一条考核**（DB 唯一键 + 服务预检双保险）；
 * 2. **提交初评时整组冻结**（R55）：6 个指标 + `compositeScore` + `weights`
 *    一次性落库，之后学生再写评价也不会改动它；
 * 3. **初评等级人工填**（R50），不由 `compositeScore` 推导。
 */
@Injectable()
export class AssessmentService {
  constructor(
    private readonly repository: AssessmentRepository,
    private readonly sysConfig: SysConfigService,
    private readonly dataScope: DataScopeService,
    private readonly users: UserService,
  ) {}

  /**
   * `POST /assessments` —— 学院为本院一位导师开一个考核周期。
   *
   * 守卫先到先拒：导师档案不存在 / 未生效 → **404 / 31102**；
   * 不在本院 → **403 / 10003**；同导师同周期已存在 → **409 / 35003**。
   */
  async create(
    dto: CreateAssessmentDto,
    caller: RequestUser,
  ): Promise<AssessmentResponseDto> {
    const profile = await this.repository.findProfileWithDept(
      BigInt(dto.mentorId),
    );
    if (profile === null || profile.status !== MENTOR_PROFILE_APPROVED) {
      throw this.mentorNotFound();
    }
    await this.assertDeptVisible(profile, caller);

    const existing = await this.repository.findByMentorPeriod(
      profile.id,
      dto.period,
    );
    if (existing !== null) {
      throw this.periodTaken();
    }

    const created = await this.repository.create(profile.id, dto.period);
    const { weights, targets } = await this.loadScoringConfig();
    const metrics = await this.metricsFor(
      profile.id,
      created.period,
      weights,
      targets,
    );
    return toAssessmentResponse(created, metrics, weights);
  }

  /**
   * `GET /assessments/rules` —— 当前生效的考核评分规则（§6.6）。
   *
   * 权重由 `resolveWeights` 归一化后回显；目标值缺省 10 / 5。
   */
  async getRules(): Promise<AssessmentRuleResponseDto> {
    const { weights, targets } = await this.loadScoringConfig();
    return {
      weights,
      targets: {
        workload: targets.workloadTargetCount,
        achievement: targets.achievementTargetCount,
      },
    };
  }

  /**
   * `PUT /assessments/rules` —— 更新权重 / 目标值（§6.6）。
   *
   * **存原始值，不存归一化值**：归一化是读路径的事，`normalized` 要随每次
   * 读取重新算。若把归一化结果写回配置，管理员再改一个值就永远看不到
   * 「原始输入和不为 1」这件事了。
   *
   * 非法输入在这里挡成 **400 / 10001**，不能落到 `resolveWeights` 的
   * 500（那是配置坏掉的口径，不是用户输入错误）。
   */
  async updateRules(
    dto: UpdateAssessmentRuleDto,
  ): Promise<AssessmentRuleResponseDto> {
    const { review, workload, achievement } = dto.weights;
    const values = [review, workload, achievement];
    if (
      values.some((value) => !Number.isFinite(value) || value < 0) ||
      values.reduce((sum, value) => sum + value, 0) <= 0
    ) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        '三个权重必须是非负数，且和大于 0',
        HttpStatus.BAD_REQUEST,
      );
    }

    const writes: Array<Promise<void>> = [
      this.sysConfig.setNumber(
        WEIGHT_CONFIG_CODES.review,
        '考核权重：学生评价',
        review,
      ),
      this.sysConfig.setNumber(
        WEIGHT_CONFIG_CODES.workload,
        '考核权重：指导工作量',
        workload,
      ),
      this.sysConfig.setNumber(
        WEIGHT_CONFIG_CODES.achievement,
        '考核权重：双创成果',
        achievement,
      ),
    ];
    if (dto.targets?.workload !== undefined) {
      writes.push(
        this.sysConfig.setNumber(
          WORKLOAD_TARGET_CONFIG_CODE,
          '考核工作量目标次数',
          dto.targets.workload,
        ),
      );
    }
    if (dto.targets?.achievement !== undefined) {
      writes.push(
        this.sysConfig.setNumber(
          ACHIEVEMENT_TARGET_CONFIG_CODE,
          '考核成果目标数',
          dto.targets.achievement,
        ),
      );
    }
    await Promise.all(writes);
    return this.getRules();
  }

  /**
   * `POST /assessments/:id/college-review` —— 学院提交初评。
   *
   * 守卫先到先拒：考核不存在 → **404 / 35001**；不在本院 → **403 / 10003**；
   * 出发态不是 `0` / `3` → **409 / 35002**。
   *
   * 提交时**先算指标再落库**，整组冻结在同一事务里（R55）。并发双发时
   * 条件更新的 `count === 0` 让输家也得到 409 / 35002。
   */
  async collegeReview(
    id: bigint,
    dto: CollegeReviewDto,
    caller: RequestUser,
  ): Promise<AssessmentResponseDto> {
    const assessment = await this.repository.findByIdWithMentor(id);
    if (assessment === null) {
      throw this.notFound();
    }
    await this.assertDeptVisible(assessment.mentor, caller);

    if (!isCollegeReviewFrom(assessment.status)) {
      throw this.transitionInvalid();
    }

    const { weights, targets } = await this.loadScoringConfig();
    const metrics = await this.metricsFor(
      assessment.mentorId,
      assessment.period,
      weights,
      targets,
    );

    const write: CollegeReviewWrite = {
      status: 1,
      weights,
      reviewAvg:
        metrics.reviewAvg === null ? null : metrics.reviewAvg.toFixed(2),
      reviewCount: metrics.reviewCount,
      guidanceCount: metrics.guidanceCount,
      guidanceMinutes: metrics.guidanceMinutes,
      studentCount: metrics.studentCount,
      achievementCount: metrics.achievementCount,
      compositeScore: metrics.compositeScore.toFixed(2),
      collegeGrade: dto.grade,
      collegeComment: dto.comment,
      collegeSubmittedAt: new Date(),
      collegeSubmittedBy: caller.userId,
    };

    const updated = await this.repository.submitCollegeReview(
      assessment.id,
      assessment.status,
      write,
    );
    if (updated === null) {
      throw this.transitionInvalid();
    }
    return toAssessmentResponse(updated, metrics, weights);
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  /**
   * `POST /assessments/:id/final-review` —— 双创学院终评（Task 40 / §6.2）。
   *
   * 守卫：考核不存在 → **404 / 35001**；`status ≠ 1` → **409 / 35002**；
   * `approve` 缺 `grade` / `return` 带 `grade` → **400 / 10001**。
   *
   * **没有部门判定**：终评方是双创学院，数据范围是 `all`。
   * 终评等级与初评等级**互不覆盖**（R54）——`approve` 时写入的 `finalGrade`
   * 可以与 `collegeGrade` 不同，`return` 时 `finalGrade` 置 `null`。
   */
  async finalReview(
    id: bigint,
    dto: FinalReviewDto,
    caller: RequestUser,
  ): Promise<AssessmentResponseDto> {
    const assessment = await this.repository.findByIdWithMentor(id);
    if (assessment === null) {
      throw this.notFound();
    }
    if (assessment.status !== ASSESSMENT_STATUS.COLLEGE_SUBMITTED) {
      throw this.transitionInvalid();
    }
    this.assertDecisionShape(dto);

    const approved = dto.decision === 'approve';
    const write: FinalReviewWrite = {
      status: approved
        ? ASSESSMENT_STATUS.APPROVED
        : ASSESSMENT_STATUS.RETURNED,
      // 退回不保留旧等级：`status = 3` 上的 finalGrade 没有任何业务含义
      finalGrade: approved ? (dto.grade ?? null) : null,
      finalComment: dto.comment,
      finalReviewedAt: new Date(),
      finalReviewedBy: caller.userId,
    };

    const updated = await this.repository.submitFinalReview(
      assessment.id,
      write,
    );
    if (updated === null) {
      throw this.transitionInvalid();
    }
    // 终评不改指标：返回冻结在行上的那一组（R55）
    const { weights } = await this.loadScoringConfig();
    return toAssessmentResponse(
      updated,
      frozenMetrics(updated),
      frozenWeights(updated, weights),
    );
  }

  /**
   * `approve` 必须带 `grade`、`return` 必须不带。
   *
   * DTO 层只能表达「`grade` 的取值合法」，表达不了「哪个决定要它」——
   * 而这条互斥是**语义**上的：退回还带等级，等于说「没通过，但定了个级」。
   */
  private assertDecisionShape(dto: FinalReviewDto): void {
    if (dto.decision === 'approve' && dto.grade === undefined) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        'decision = approve 时必须给出 grade',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (dto.decision === 'return' && dto.grade !== undefined) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        'decision = return 时不能给出 grade',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * `GET /assessments`（Task 41）——三种视角：导师看自己的、学院看本院、双创学院看全校。
   *
   * **列表只回冻结值**：`status = 0` 的行指标列还没冻结，回 `null` / 0。
   * 实时试算只在详情里做——翻页时每行三次聚合会把一个列表变成几十次数据库往返，
   * 而「待初评」的行本来就没有权威指标，前端点进详情看试算即可。
   */
  async list(
    query: QueryAssessmentDto,
    caller: RequestUser,
  ): Promise<AssessmentListResponseDto> {
    const where = await this.buildListWhere(query, caller);
    const [rows, total] = await this.repository.findPage(
      where,
      (query.page - 1) * query.pageSize,
      query.pageSize,
    );
    const { weights } = await this.loadScoringConfig();

    return {
      list: rows.map((row) =>
        toAssessmentResponse(
          row,
          frozenMetrics(row),
          this.weightsForRow(row, weights),
        ),
      ),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * `GET /assessments/:id`（Task 41）。
   *
   * 不存在 → **404 / 35001**；不可见 → **403 / 10003**。
   * `status = 0` 回**实时试算**（按当前配置现算），`status ≥ 1` 回**冻结值**（R55）。
   */
  async findById(
    id: bigint,
    caller: RequestUser,
  ): Promise<AssessmentResponseDto> {
    const assessment = await this.repository.findByIdWithMentor(id);
    if (assessment === null) {
      throw this.notFound();
    }
    await this.assertVisible(assessment, caller);

    const { weights, targets } = await this.loadScoringConfig();
    if (assessment.status === ASSESSMENT_STATUS.DRAFT) {
      const metrics = await this.metricsFor(
        assessment.mentorId,
        assessment.period,
        weights,
        targets,
      );
      return toAssessmentResponse(assessment, metrics, weights);
    }
    return toAssessmentResponse(
      assessment,
      frozenMetrics(assessment),
      frozenWeights(assessment, weights),
    );
  }

  /**
   * `POST /assessments/:id/appeals` —— 导师对**已生效**的考核结果申诉（§3.8）。
   *
   * 守卫：考核不存在 → **404 / 35001**；不是该导师本人 → **403 / 10003**；
   * `status ≠ 2 APPROVED` → **409 / 35006**；已有待处理申诉 → **409 / 35005**。
   *
   * **不修改 `Assessment`**（R56）：申诉只是「我不同意，请复核」，
   * 它不该在受理之前就改变结果。
   */
  async createAppeal(
    id: bigint,
    dto: CreateAppealDto,
    caller: RequestUser,
  ): Promise<AppealResponseDto> {
    const assessment = await this.repository.findByIdWithMentor(id);
    if (assessment === null) {
      throw this.notFound();
    }

    const user = await this.users.findById(caller.userId);
    const person =
      user === null
        ? null
        : await this.repository.findPersonByLogin(user.username);
    if (person === null || person.id !== assessment.mentor.personId) {
      throw this.forbidden();
    }

    if (assessment.status !== ASSESSMENT_STATUS.APPROVED) {
      throw this.appealNotAllowed();
    }
    const pending = await this.repository.findPendingAppeal(id);
    if (pending !== null) {
      throw this.appealPending();
    }

    const created = await this.repository.createAppeal(id, dto.reason);
    return toAppealResponse(created);
  }

  /** `GET /assessments/:id/appeals` —— 可见性与考核详情同源 */
  async listAppeals(
    id: bigint,
    query: QueryAppealDto,
    caller: RequestUser,
  ): Promise<AppealListResponseDto> {
    const assessment = await this.repository.findByIdWithMentor(id);
    if (assessment === null) {
      throw this.notFound();
    }
    await this.assertVisible(assessment, caller);

    const [rows, total] = await this.repository.findAppealsByAssessment(
      id,
      (query.page - 1) * query.pageSize,
      query.pageSize,
    );
    return {
      list: rows.map(toAppealResponse),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * `POST /assessments/:id/appeals/:appealId/handle` —— 双创学院处理申诉（R56）。
   *
   * 守卫：考核不存在 → **404 / 35001**；申诉不存在 / 不属于该考核 → **404 / 35004**；
   * 申诉状态不是 `0 PENDING` → **409 / 35002**（并发里输掉的一方同样走这条）。
   *
   * **不修改 `Assessment`**：受理只表示已收到并会复核，不是重新定级。
   */
  async handleAppeal(
    id: bigint,
    appealId: bigint,
    dto: HandleAppealDto,
    caller: RequestUser,
  ): Promise<AppealResponseDto> {
    const assessment = await this.repository.findByIdWithMentor(id);
    if (assessment === null) {
      throw this.notFound();
    }
    const appeal = await this.repository.findAppealById(id, appealId);
    if (appeal === null) {
      throw this.appealNotFound();
    }

    const updated = await this.repository.handleAppeal(appealId, {
      status:
        dto.decision === 'accept'
          ? APPEAL_STATUS.ACCEPTED
          : APPEAL_STATUS.REJECTED,
      reply: dto.reply,
      handledAt: new Date(),
      handledBy: caller.userId,
    });
    if (updated === null) {
      throw this.transitionInvalid();
    }
    return toAppealResponse(updated);
  }

  /** `status = 0` 用当前配置的权重；已提交的用冻结在行上的那一组 */
  private weightsForRow(
    row: Assessment,
    current: ResolvedWeights,
  ): ResolvedWeights {
    return row.status === ASSESSMENT_STATUS.DRAFT
      ? current
      : frozenWeights(row, current);
  }

  /** 列表的 where：先按查询参数，再按调用者的有效数据范围收窄 */
  private async buildListWhere(
    query: QueryAssessmentDto,
    caller: RequestUser,
  ): Promise<Prisma.AssessmentWhereInput> {
    const where: Prisma.AssessmentWhereInput = {};
    if (query.period !== undefined) {
      where.period = query.period;
    }
    if (query.status !== undefined) {
      where.status = query.status;
    }
    if (query.grade !== undefined) {
      // 「终评等级优先，未终评的看初评」——Prisma 没有 COALESCE，用两条 OR 表达
      where.OR = [
        { finalGrade: query.grade },
        { finalGrade: null, collegeGrade: query.grade },
      ];
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

    if (scope.kind === 'depts') {
      where.mentor = {
        person: { orgUnit: { deptId: { in: scope.deptIds } } },
      };
    } else if (scope.kind === 'self') {
      const person =
        user === null
          ? null
          : await this.repository.findPersonByLogin(user.username);
      // 解析不出人 → 一条都不给（`-1n` 不可能命中自增主键）
      where.mentor = { personId: person?.id ?? -1n };
    }
    return where;
  }

  /** 详情可见性：导师本人 / 覆盖导师所在部门的管理员 */
  private async assertVisible(
    assessment: AssessmentWithMentor,
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
      if (person !== null && person.id === assessment.mentor.personId) {
        return;
      }
      throw this.forbidden();
    }
    const mentorDeptId = assessment.mentor.person.orgUnit?.deptId ?? null;
    if (mentorDeptId !== null && isDeptInFilter(scope, mentorDeptId)) {
      return;
    }
    throw this.forbidden();
  }

  private metricsFor(
    mentorId: bigint,
    period: string,
    weights: ResolvedWeights,
    targets: MetricTargets,
  ): Promise<AssessmentMetrics> {
    return computeMetrics(this.repository, mentorId, period, weights, targets);
  }

  /** 权重与目标值都从 `SysConfig` 读，缺省用 `assessment.constants.ts` 的默认值 */
  private async loadScoringConfig(): Promise<{
    weights: ResolvedWeights;
    targets: MetricTargets;
  }> {
    const [review, workload, achievement, workloadTarget, achievementTarget] =
      await Promise.all([
        this.sysConfig.getNumber(
          WEIGHT_CONFIG_CODES.review,
          DEFAULT_WEIGHTS.review,
        ),
        this.sysConfig.getNumber(
          WEIGHT_CONFIG_CODES.workload,
          DEFAULT_WEIGHTS.workload,
        ),
        this.sysConfig.getNumber(
          WEIGHT_CONFIG_CODES.achievement,
          DEFAULT_WEIGHTS.achievement,
        ),
        this.sysConfig.getNumber(
          WORKLOAD_TARGET_CONFIG_CODE,
          DEFAULT_WORKLOAD_TARGET_COUNT,
        ),
        this.sysConfig.getNumber(
          ACHIEVEMENT_TARGET_CONFIG_CODE,
          DEFAULT_ACHIEVEMENT_TARGET_COUNT,
        ),
      ]);

    return {
      weights: resolveWeights({ review, workload, achievement }),
      targets: {
        workloadTargetCount: workloadTarget,
        achievementTargetCount: achievementTarget,
      },
    };
  }

  /**
   * 部门可见性：调用者的有效数据范围必须覆盖**导师所在部门**。
   *
   * 与 P2 的 `adjudicate` 同一做法：`@DataScope('dept')` 是天花板，
   * 服务内再按「导师的部门」判一次——天花板被改宽时也不会越权。
   * 不覆盖 → **403 / 10003**（通用码，不是预约段的 32002）。
   */
  private async assertDeptVisible(
    profile: ProfileWithDept,
    caller: RequestUser,
  ): Promise<void> {
    // 必须把**调用者自己的部门**传进去：`resolve` 在拿到部门级范围却没有部门时
    // 会回落到「一行都看不见」（fail-closed）。传 null 的话所有学院管理员
    // 都会被自己的正确配置挡成 403。
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
    const deptId = profile.person.orgUnit?.deptId ?? null;
    if (deptId !== null && isDeptInFilter(scope, deptId)) {
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

  private notFound(): BusinessException {
    return new BusinessException(
      ErrorCode.ASSESSMENT_NOT_FOUND,
      '考核不存在',
      HttpStatus.NOT_FOUND,
    );
  }

  private periodTaken(): BusinessException {
    return new BusinessException(
      ErrorCode.ASSESSMENT_PERIOD_TAKEN,
      '该导师本周期已有考核',
      HttpStatus.CONFLICT,
    );
  }

  private transitionInvalid(): BusinessException {
    return new BusinessException(
      ErrorCode.ASSESSMENT_TRANSITION_INVALID,
      '当前状态不允许该操作',
      HttpStatus.CONFLICT,
    );
  }

  private appealNotFound(): BusinessException {
    return new BusinessException(
      ErrorCode.ASSESSMENT_APPEAL_NOT_FOUND,
      '考核申诉不存在',
      HttpStatus.NOT_FOUND,
    );
  }

  private appealPending(): BusinessException {
    return new BusinessException(
      ErrorCode.ASSESSMENT_APPEAL_PENDING,
      '该考核已有待处理的申诉',
      HttpStatus.CONFLICT,
    );
  }

  private appealNotAllowed(): BusinessException {
    return new BusinessException(
      ErrorCode.ASSESSMENT_APPEAL_NOT_ALLOWED,
      '当前考核状态不允许申诉',
      HttpStatus.CONFLICT,
    );
  }

  private forbidden(): BusinessException {
    return new BusinessException(
      ErrorCode.FORBIDDEN,
      '无权限',
      HttpStatus.FORBIDDEN,
    );
  }
}

function isCollegeReviewFrom(status: number): boolean {
  return (COLLEGE_REVIEW_FROM_STATUSES as readonly number[]).includes(status);
}
