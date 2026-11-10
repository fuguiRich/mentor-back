import { HttpStatus, Injectable, type StreamableFile } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ArchiveItem } from '@prisma/client';
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
import { ConfigService as SysConfigService } from '../config/config.service';
import { DataScopeService } from '../data-scope/data-scope.service';
import { FileService } from '../file/file.service';
import { UserService } from '../user/user.service';
import {
  ARCHIVE_NONCORE_RETENTION_DAYS_CODE,
  DEFAULT_ARCHIVE_NONCORE_RETENTION_DAYS,
} from './archive.constants';
import { toArchiveResponse, archiveFileIds } from './archive.mapper';
import {
  ArchiveRepository,
  type ArchiveFilter,
  type ArchivePatch,
} from './archive.repository';
import { addDays, dateColumnFromString, todayInTimeZone } from './archive.time';
import type { ArchiveResponseDto } from './dto/archive-response.dto';
import type { CreateArchiveDto } from './dto/create-archive.dto';
import type { ListArchiveQueryDto } from './dto/list-archive-query.dto';
import type { UpdateArchiveDto } from './dto/update-archive.dto';

/**
 * 归档（P4 Task 52 / §4.7）。
 *
 * 三条不变量：
 * 1. **自动归档在审核事务里**（R66）——两个审核通过点自己落库，本服务只负责
 *    手工归档与检索，不从读路径反向写。
 * 2. **手工归档一律非核心**（`core = 0`）：`core` 不是调用方能声明的字段，
 *    核心 / 非核心决定「永久保存还是到期清理」。
 * 3. **检索按快照的 `deptId` 收窄**：导师调岗不改历史归档的归属；
 *    `deptId` 为空的条目对部门级管理员不可见（fail-closed）。
 */
@Injectable()
export class ArchiveService {
  private readonly timeZone: string;

  constructor(
    private readonly repository: ArchiveRepository,
    private readonly users: UserService,
    private readonly dataScope: DataScopeService,
    private readonly sysConfig: SysConfigService,
    private readonly fileService: FileService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.timeZone = config.getOrThrow('app.timezone', { infer: true });
  }

  /** `POST /archives` —— 管理员手工归档（`core = 0` + 保留期） */
  async create(dto: CreateArchiveDto): Promise<ArchiveResponseDto> {
    const existing = await this.repository.findByTarget(
      dto.targetType,
      dto.targetId,
    );
    if (existing !== null) {
      throw this.alreadyExists();
    }

    const now = new Date();
    const retentionDays = await this.retentionDays();
    const fileIds = await this.normalizeFileIds(dto.fileIds);
    const created = await this.repository.create({
      targetType: dto.targetType,
      targetId: dto.targetId,
      title: dto.title,
      mentorId: dto.mentorId === undefined ? null : BigInt(dto.mentorId),
      deptId: dto.deptId === undefined ? null : BigInt(dto.deptId),
      category: dto.category,
      core: 0,
      archivedAt: now,
      retentionUntil: addDays(
        todayInTimeZone(now, this.timeZone),
        retentionDays,
      ),
      summary: dto.summary ?? null,
      fileIds,
    });
    return this.toResponse(created);
  }

  /** `GET /archives` —— 按调用者的数据范围收窄 */
  async list(
    query: ListArchiveQueryDto,
    caller: RequestUser,
  ): Promise<{
    list: ArchiveResponseDto[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const scope = await this.resolveScope(caller);
    const filter = await this.buildFilter(query, scope, caller);
    if (filter === null) {
      return {
        list: [],
        total: 0,
        page: query.page,
        pageSize: query.pageSize,
      };
    }

    const [rows, total] = await this.repository.findPage(
      filter,
      (query.page - 1) * query.pageSize,
      query.pageSize,
    );
    return {
      list: await this.toResponses(rows),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** `GET /archives/:id` */
  async findById(id: bigint, caller: RequestUser): Promise<ArchiveResponseDto> {
    const row = await this.repository.findById(id);
    if (row === null) {
      throw this.notFound();
    }
    const scope = await this.resolveScope(caller);
    if (scope.kind === 'all') {
      return this.toResponse(row);
    }
    if (scope.kind === 'depts') {
      if (row.deptId !== null && isDeptInFilter(scope, row.deptId)) {
        return this.toResponse(row);
      }
      throw this.forbidden();
    }

    const ownMentorId = await this.resolveSelfMentorId(caller);
    if (ownMentorId !== null && row.mentorId === ownMentorId) {
      return this.toResponse(row);
    }
    throw this.forbidden();
  }

  /** `PATCH /archives/:id` —— 改标题 / 摘要 / 保留期（Task 53） */
  async update(
    id: bigint,
    dto: UpdateArchiveDto,
    caller: RequestUser,
  ): Promise<ArchiveResponseDto> {
    const row = await this.assertVisible(id, caller);
    const patch: ArchivePatch = {};
    if (dto.title !== undefined) {
      patch.title = dto.title;
    }
    if (dto.summary !== undefined) {
      patch.summary = dto.summary;
    }
    if (dto.retentionUntil !== undefined) {
      if (dto.retentionUntil === null) {
        patch.retentionUntil = null;
      } else {
        // R64：核心材料永久保存，保留期恒为 NULL
        if (row.core === 1) {
          throw this.paramInvalid('核心材料不允许设置保留期');
        }
        patch.retentionUntil = dateColumnFromString(dto.retentionUntil);
      }
    }
    if (dto.fileIds !== undefined) {
      patch.fileIds = await this.normalizeFileIds(dto.fileIds);
    }
    if (Object.keys(patch).length === 0) {
      return this.toResponse(row);
    }
    return this.toResponse(await this.repository.update(row.id, patch));
  }

  /** `GET /archives/:id/files/:fileId/preview` */
  async previewFile(
    id: bigint,
    fileId: bigint,
    caller: RequestUser,
  ): Promise<StreamableFile> {
    return this.serveFile(id, fileId, caller, 'inline');
  }

  /** `GET /archives/:id/files/:fileId/download` */
  async downloadFile(
    id: bigint,
    fileId: bigint,
    caller: RequestUser,
  ): Promise<StreamableFile> {
    return this.serveFile(
      id,
      fileId,
      caller,
      'attachment',
      'application/octet-stream',
    );
  }

  private async serveFile(
    id: bigint,
    fileId: bigint,
    caller: RequestUser,
    disposition: 'inline' | 'attachment',
    type?: string,
  ): Promise<StreamableFile> {
    const row = await this.assertVisible(id, caller);
    if (!archiveFileIds(row).includes(fileId.toString())) {
      throw this.fileNotFound();
    }
    return this.fileService.serve(fileId, disposition, type);
  }

  /** `DELETE /archives/:id` —— 软删（取消归档）；之后同一目标可再归档 */
  async remove(id: bigint, caller: RequestUser): Promise<{ id: string }> {
    const row = await this.assertVisible(id, caller);
    await this.repository.softDelete(row.id);
    return { id: row.id.toString() };
  }

  /**
   * `POST /archives/purge` 与定时任务共用（Task 53 / R65）。
   *
   * 只软删 `archive_item`，**不碰 `SysFile`**：文件被多处引用，按归档条目
   * 删文件会连带删掉别处的引用。幂等：第二次 `purged = 0`。
   */
  async purge(): Promise<{ purged: number }> {
    const now = new Date();
    const today = todayInTimeZone(now, this.timeZone);
    const purged = await this.repository.purgeExpired(today, now);
    return { purged };
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  /** 去重 + 校验附件存在；空数组表示清空 */
  private async normalizeFileIds(
    raw: readonly string[] | undefined,
  ): Promise<string[]> {
    if (raw === undefined || raw.length === 0) {
      return [];
    }
    const ids = [...new Set(raw)];
    const files = await this.repository.findFilesByIds(
      ids.map((id) => BigInt(id)),
    );
    if (files.length !== ids.length) {
      throw this.fileNotFound();
    }
    return ids;
  }

  private async toResponses(
    rows: readonly ArchiveItem[],
  ): Promise<ArchiveResponseDto[]> {
    const ids = [...new Set(rows.flatMap((row) => archiveFileIds(row)))].map(
      (id) => BigInt(id),
    );
    const files = await this.repository.findFilesByIds(ids);
    const byId = new Map(files.map((file) => [file.id.toString(), file]));
    return rows.map((row) =>
      toArchiveResponse(
        row,
        archiveFileIds(row)
          .map((id) => byId.get(id))
          .filter(
            (
              file,
            ): file is {
              id: bigint;
              originName: string;
              mimeType: string;
              size: number;
            } => file !== undefined,
          ),
      ),
    );
  }

  private async toResponse(row: ArchiveItem): Promise<ArchiveResponseDto> {
    const [response] = await this.toResponses([row]);
    return response;
  }

  private fileNotFound(): BusinessException {
    return new BusinessException(
      ErrorCode.FILE_NOT_FOUND,
      '文件不存在',
      HttpStatus.NOT_FOUND,
    );
  }

  private async assertVisible(
    id: bigint,
    caller: RequestUser,
  ): Promise<ArchiveItem> {
    const row = await this.repository.findById(id);
    if (row === null) {
      throw this.notFound();
    }
    const scope = await this.resolveScope(caller);
    if (scope.kind === 'all') {
      return row;
    }
    if (scope.kind === 'depts') {
      if (row.deptId !== null && isDeptInFilter(scope, row.deptId)) {
        return row;
      }
      throw this.forbidden();
    }
    const ownMentorId = await this.resolveSelfMentorId(caller);
    if (ownMentorId !== null && row.mentorId === ownMentorId) {
      return row;
    }
    throw this.forbidden();
  }

  /**
   * 检索条件。`null` 表示「范围解析出来是空的」——直接回空页，
   * 不把 `mentorId: null` 之类的假条件发给数据库。
   */
  private async buildFilter(
    query: ListArchiveQueryDto,
    scope: DataScopeFilter,
    caller: RequestUser,
  ): Promise<ArchiveFilter | null> {
    const filter: ArchiveFilter = {};

    if (query.deptId !== undefined) {
      if (scope.kind !== 'all') {
        throw this.forbidden();
      }
      filter.deptId = BigInt(query.deptId);
    }

    if (scope.kind === 'depts') {
      filter.deptIds = scope.deptIds;
    }

    if (scope.kind === 'self') {
      const ownMentorId = await this.resolveSelfMentorId(caller);
      if (ownMentorId === null) {
        return null;
      }
      filter.mentorId = ownMentorId;
    }

    if (query.mentorId !== undefined) {
      const mentorId = BigInt(query.mentorId);
      if (filter.mentorId !== undefined && filter.mentorId !== mentorId) {
        throw this.forbidden();
      }
      filter.mentorId = mentorId;
    }

    if (query.category !== undefined) {
      filter.category = query.category;
    }
    if (query.targetType !== undefined) {
      filter.targetType = query.targetType;
    }

    const hasFrom = query.from !== undefined;
    const hasTo = query.to !== undefined;
    if (hasFrom !== hasTo) {
      throw this.paramInvalid('from 与 to 必须成对出现');
    }
    if (hasFrom && hasTo) {
      const from = dateColumnFromString(query.from as string);
      const toExclusive = addDays(dateColumnFromString(query.to as string), 1);
      if (from >= toExclusive) {
        throw this.paramInvalid('from 必须不晚于 to');
      }
      filter.archivedAtFrom = from;
      filter.archivedAtTo = toExclusive;
    }

    return filter;
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

  /** 导师本人 → `MentorProfile.id`（`self` 范围的归档归属） */
  private async resolveSelfMentorId(
    caller: RequestUser,
  ): Promise<bigint | null> {
    const user = await this.users.findById(caller.userId);
    if (user === null) {
      return null;
    }
    const person = await this.repository.findPersonByLogin(user.username);
    if (person === null) {
      return null;
    }
    const profile = await this.repository.findProfileByPersonId(person.id);
    return profile?.id ?? null;
  }

  private async retentionDays(): Promise<number> {
    const configured = await this.sysConfig.getNumber(
      ARCHIVE_NONCORE_RETENTION_DAYS_CODE,
      DEFAULT_ARCHIVE_NONCORE_RETENTION_DAYS,
    );
    return configured > 0
      ? Math.floor(configured)
      : DEFAULT_ARCHIVE_NONCORE_RETENTION_DAYS;
  }

  private notFound(): BusinessException {
    return new BusinessException(
      ErrorCode.ARCHIVE_NOT_FOUND,
      '归档条目不存在',
      HttpStatus.NOT_FOUND,
    );
  }

  private alreadyExists(): BusinessException {
    return new BusinessException(
      ErrorCode.ARCHIVE_ALREADY_EXISTS,
      '该记录已归档',
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

  private paramInvalid(message: string): BusinessException {
    return new BusinessException(
      ErrorCode.PARAM_INVALID,
      message,
      HttpStatus.BAD_REQUEST,
    );
  }
}
