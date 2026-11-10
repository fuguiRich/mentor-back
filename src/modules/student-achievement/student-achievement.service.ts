import { HttpStatus, Injectable, type StreamableFile } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { ErrorCode } from '../../common/constants/error-code';
import {
  isDeptInFilter,
  type DataScopeFilter,
} from '../../common/constants/data-scope';
import {
  currentDataScopeCeiling,
  type RequestUser,
} from '../../common/context/request-context';
import { BusinessException } from '../../common/errors/business.exception';
import {
  ARCHIVE_NONCORE_RETENTION_DAYS_CODE,
  DEFAULT_ARCHIVE_NONCORE_RETENTION_DAYS,
} from '../archive/archive.constants';
import { addDays, todayInTimeZone } from '../archive/archive.time';
import { toDateColumn } from '../achievement/achievement.mapper';
import { ConfigService as SysConfigService } from '../config/config.service';
import { DataScopeService } from '../data-scope/data-scope.service';
import { FileService } from '../file/file.service';
import { UserService } from '../user/user.service';
import type { CreateStudentAchievementDto } from './dto/create-student-achievement.dto';
import type { LinkStudentAchievementDto } from './dto/link-student-achievement.dto';
import type { QueryStudentAchievementDto } from './dto/query-student-achievement.dto';
import type {
  StudentAchievementListResponseDto,
  StudentAchievementResponseDto,
} from './dto/student-achievement-response.dto';
import type {
  QueryStudentOptionDto,
  StudentOptionListResponseDto,
} from './dto/student-option.dto';
import { toStudentAchievementResponse } from './student-achievement.mapper';
import {
  StudentAchievementRepository,
  type StudentAchievementFilter,
} from './student-achievement.repository';

/**
 * 学生成果与人工关联（P5 Task 59 / §5.4）。
 *
 * 三条不变量：
 * 1. **人工关联**（P5-R3）：管理员显式选择导师，不做自动识别。
 * 2. **关联是原子的**：导师 `Achievement`、`student_achievement` 回填、归档条目
 *    在同一个事务里；任一步失败整体回滚。
 * 3. **按学生所在学院收窄**：`deptId` 是学生学院的快照，不是导师学院；
 *    学院管理员只能建 / 改本院学生的成果。
 */
@Injectable()
export class StudentAchievementService {
  private readonly timeZone: string;

  constructor(
    private readonly repository: StudentAchievementRepository,
    private readonly users: UserService,
    private readonly dataScope: DataScopeService,
    private readonly sysConfig: SysConfigService,
    private readonly fileService: FileService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.timeZone = config.getOrThrow('app.timezone', { infer: true });
  }

  /** `POST /student-achievements` */
  async create(
    dto: CreateStudentAchievementDto,
    caller: RequestUser,
  ): Promise<StudentAchievementResponseDto> {
    const student = await this.repository.findStudentById(
      BigInt(dto.studentPersonId),
    );
    if (student === null || student.personType !== 'student') {
      throw new BusinessException(
        ErrorCode.NOT_FOUND,
        '学生不存在',
        HttpStatus.NOT_FOUND,
      );
    }
    const deptId = student.orgUnit?.deptId ?? null;
    await this.assertDeptVisible(deptId, caller);

    const mentor =
      dto.mentorProfileId === undefined
        ? null
        : await this.requireMentor(BigInt(dto.mentorProfileId));

    const created = await this.repository.create({
      studentPersonId: student.id,
      deptId,
      type: dto.type,
      title: dto.title,
      level: dto.level,
      awardedAt: toDateColumn(dto.awardedAt),
      proofFileId:
        dto.proofFileId === undefined ? null : BigInt(dto.proofFileId),
    });

    if (mentor !== null) {
      const linked = await this.repository.link(
        created.id,
        mentor.id,
        caller.userId,
        await this.archivePayload(),
      );
      if (!linked) {
        throw this.alreadyLinked();
      }
    }
    return this.reload(created.id);
  }

  /** `PATCH /student-achievements/:id/link` —— 人工关联导师 */
  async link(
    id: bigint,
    dto: LinkStudentAchievementDto,
    caller: RequestUser,
  ): Promise<StudentAchievementResponseDto> {
    const row = await this.repository.findById(id);
    if (row === null) {
      throw this.notFound();
    }
    await this.assertDeptVisible(row.deptId, caller);
    if (row.mentorId !== null) {
      throw this.alreadyLinked();
    }

    const mentor = await this.requireMentor(BigInt(dto.mentorProfileId));
    const linked = await this.repository.link(
      row.id,
      mentor.id,
      caller.userId,
      await this.archivePayload(),
    );
    if (!linked) {
      throw this.alreadyLinked();
    }
    return this.reload(row.id);
  }

  /** `DELETE /student-achievements/:id` —— 软删，连带导师成果与归档 */
  async remove(id: bigint, caller: RequestUser): Promise<{ id: string }> {
    const row = await this.repository.findById(id);
    if (row === null) {
      throw this.notFound();
    }
    await this.assertDeptVisible(row.deptId, caller);
    await this.repository.softDeleteWithLinked(row.id);
    return { id: row.id.toString() };
  }

  /** `GET /student-achievements/students` —— 学生下拉目录 */
  async listStudentOptions(
    query: QueryStudentOptionDto,
    caller: RequestUser,
  ): Promise<StudentOptionListResponseDto> {
    const scope = await this.resolveScope(caller);
    if (scope.kind === 'self') {
      return {
        list: [],
        total: 0,
        page: query.page,
        pageSize: query.pageSize,
      };
    }

    const deptId =
      query.deptId === undefined ? undefined : BigInt(query.deptId);
    if (
      deptId !== undefined &&
      scope.kind === 'depts' &&
      !isDeptInFilter(scope, deptId)
    ) {
      throw this.forbidden();
    }

    const [rows, total] = await this.repository.findStudents(
      {
        ...(query.keyword === undefined ? {} : { keyword: query.keyword }),
        ...(deptId === undefined ? {} : { deptId }),
        ...(scope.kind === 'depts' && deptId === undefined
          ? { deptIds: scope.deptIds }
          : {}),
      },
      (query.page - 1) * query.pageSize,
      query.pageSize,
    );
    return {
      list: rows.map((row) => ({
        id: row.id.toString(),
        login: row.login,
        realName: row.realName,
        deptId:
          row.orgUnit?.deptId === null || row.orgUnit?.deptId === undefined
            ? null
            : row.orgUnit.deptId.toString(),
        deptName: row.orgUnit?.name ?? null,
        major: row.major,
        className: row.className,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** `GET /student-achievements` */
  async list(
    query: QueryStudentAchievementDto,
    caller: RequestUser,
  ): Promise<StudentAchievementListResponseDto> {
    const scope = await this.resolveScope(caller);
    const filter: StudentAchievementFilter = {};

    if (scope.kind === 'depts') {
      filter.deptIds = scope.deptIds;
    }
    if (scope.kind === 'self') {
      const own = await this.resolveSelf(caller);
      if (own === null) {
        return {
          list: [],
          total: 0,
          page: query.page,
          pageSize: query.pageSize,
        };
      }
      if (own.kind === 'student') {
        filter.studentPersonId = own.personId;
      } else {
        filter.mentorId = own.mentorId;
      }
    }

    if (query.studentPersonId !== undefined) {
      const studentPersonId = BigInt(query.studentPersonId);
      if (
        filter.studentPersonId !== undefined &&
        filter.studentPersonId !== studentPersonId
      ) {
        throw this.forbidden();
      }
      filter.studentPersonId = studentPersonId;
    }
    if (query.mentorId !== undefined) {
      const mentorId = BigInt(query.mentorId);
      if (filter.mentorId !== undefined && filter.mentorId !== mentorId) {
        throw this.forbidden();
      }
      filter.mentorId = mentorId;
    }
    if (query.type !== undefined) {
      filter.type = query.type;
    }
    if (query.linked !== undefined) {
      filter.linked = query.linked;
    }
    if (query.year !== undefined) {
      filter.awardedAtFrom = new Date(Date.UTC(query.year, 0, 1));
      filter.awardedAtTo = new Date(Date.UTC(query.year + 1, 0, 1));
    }

    const [rows, total] = await this.repository.findPage(
      filter,
      (query.page - 1) * query.pageSize,
      query.pageSize,
    );
    return {
      list: rows.map(toStudentAchievementResponse),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  /** `GET /student-achievements/:id/proof/preview` —— 行内预览佐证 */
  async previewProof(id: bigint, caller: RequestUser): Promise<StreamableFile> {
    return this.serveProof(id, caller, 'inline');
  }

  /** `GET /student-achievements/:id/proof/download` —— 下载佐证 */
  async downloadProof(
    id: bigint,
    caller: RequestUser,
  ): Promise<StreamableFile> {
    return this.serveProof(
      id,
      caller,
      'attachment',
      'application/octet-stream',
    );
  }

  private async serveProof(
    id: bigint,
    caller: RequestUser,
    disposition: 'inline' | 'attachment',
    type?: string,
  ): Promise<StreamableFile> {
    const row = await this.repository.findById(id);
    if (row === null) {
      throw this.notFound();
    }
    await this.assertVisible(row, caller);
    if (row.proofFileId === null) {
      throw this.proofNotFound();
    }
    return this.fileService.serve(row.proofFileId, disposition, type);
  }

  /** 单条可见性：与列表同一套口径（all / 本院 / 本人） */
  private async assertVisible(
    row: {
      studentPersonId: bigint;
      mentorId: bigint | null;
      deptId: bigint | null;
    },
    caller: RequestUser,
  ): Promise<void> {
    const scope = await this.resolveScope(caller);
    if (scope.kind === 'all') {
      return;
    }
    if (
      scope.kind === 'depts' &&
      row.deptId !== null &&
      isDeptInFilter(scope, row.deptId)
    ) {
      return;
    }
    if (scope.kind === 'self') {
      const own = await this.resolveSelf(caller);
      if (own?.kind === 'student' && own.personId === row.studentPersonId) {
        return;
      }
      if (
        own?.kind === 'mentor' &&
        row.mentorId !== null &&
        own.mentorId === row.mentorId
      ) {
        return;
      }
    }
    throw this.forbidden();
  }

  private proofNotFound(): BusinessException {
    return new BusinessException(
      ErrorCode.FILE_NOT_FOUND,
      '文件不存在',
      HttpStatus.NOT_FOUND,
    );
  }

  private async reload(id: bigint): Promise<StudentAchievementResponseDto> {
    const row = await this.repository.findById(id);
    if (row === null) {
      throw this.notFound();
    }
    return toStudentAchievementResponse(row);
  }

  private async requireMentor(id: bigint): Promise<{ id: bigint }> {
    const mentor = await this.repository.findApprovedMentorById(id);
    if (mentor === null) {
      throw new BusinessException(
        ErrorCode.MENTOR_PROFILE_NOT_FOUND,
        '导师专业档案不存在',
        HttpStatus.NOT_FOUND,
      );
    }
    return mentor;
  }

  /** 关联时同事务落归档：非核心、保留期 = 今天 + `archive.noncore_retention_days` */
  private async archivePayload(): Promise<{
    archivedAt: Date;
    retentionUntil: Date;
  }> {
    const now = new Date();
    const configured = await this.sysConfig.getNumber(
      ARCHIVE_NONCORE_RETENTION_DAYS_CODE,
      DEFAULT_ARCHIVE_NONCORE_RETENTION_DAYS,
    );
    const days =
      configured > 0
        ? Math.floor(configured)
        : DEFAULT_ARCHIVE_NONCORE_RETENTION_DAYS;
    return {
      archivedAt: now,
      retentionUntil: addDays(todayInTimeZone(now, this.timeZone), days),
    };
  }

  private async assertDeptVisible(
    deptId: bigint | null,
    caller: RequestUser,
  ): Promise<void> {
    const scope = await this.resolveScope(caller);
    if (scope.kind === 'all') {
      return;
    }
    if (
      scope.kind === 'depts' &&
      deptId !== null &&
      isDeptInFilter(scope, deptId)
    ) {
      return;
    }
    throw this.forbidden();
  }

  /** `self`：学生按本人、导师按本人档案；都不是 → 空页 */
  private async resolveSelf(
    caller: RequestUser,
  ): Promise<
    | { kind: 'student'; personId: bigint }
    | { kind: 'mentor'; mentorId: bigint }
    | null
  > {
    const user = await this.users.findById(caller.userId);
    if (user === null) {
      return null;
    }
    const person = await this.repository.findPersonByLogin(user.username);
    if (person === null) {
      return null;
    }
    if (person.personType === 'student') {
      return { kind: 'student', personId: person.id };
    }
    const profile = await this.repository.findProfileByPersonId(person.id);
    return profile === null ? null : { kind: 'mentor', mentorId: profile.id };
  }

  private async resolveScope(caller: RequestUser): Promise<DataScopeFilter> {
    const user = await this.users.findById(caller.userId);
    return this.dataScope.resolve(
      {
        userId: caller.userId,
        isSuperAdmin: caller.isSuperAdmin,
        deptId: user?.deptId ?? null,
      },
      currentDataScopeCeiling(),
    );
  }

  private notFound(): BusinessException {
    return new BusinessException(
      ErrorCode.STUDENT_ACHIEVEMENT_NOT_FOUND,
      '学生成果不存在',
      HttpStatus.NOT_FOUND,
    );
  }

  private alreadyLinked(): BusinessException {
    return new BusinessException(
      ErrorCode.STUDENT_ACHIEVEMENT_ALREADY_LINKED,
      '该成果已关联导师',
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
