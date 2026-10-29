import { HttpStatus, Injectable, type StreamableFile } from '@nestjs/common';
import type { SyncPerson } from '@prisma/client';
import { ErrorCode } from '../../common/constants/error-code';
import type { DataScopeFilter } from '../../common/constants/data-scope';
import {
  currentDataScopeCeiling,
  type RequestUser,
} from '../../common/context/request-context';
import { BusinessException } from '../../common/errors/business.exception';
import { DataScopeService } from '../data-scope/data-scope.service';
import { FileService } from '../file/file.service';
import { UserService } from '../user/user.service';
import { MENTOR_APPLICATION_STATUS } from '../mentor-application/dto/mentor-application-response.dto';
import type { AttachMaterialDto } from './dto/attach-material.dto';
import type {
  MaterialListResponseDto,
  MaterialResponseDto,
} from './dto/material-response.dto';
import { toMaterialResponse } from './mentor-material.mapper';
import type { MaterialApplicationWithApplicant } from './mentor-material.repository';
import { MentorMaterialRepository } from './mentor-material.repository';

/**
 * 挂 / 摘材料允许的申请状态（裁定 R62）：`2 COLLEGE_REVIEWING` /
 * `3 COLLEGE_REJECTED`——这两个状态正是 withdraw 允许的非终态，即
 * 「申请人还握着这条申请」。`{4, 5, 6, 7}` 一律 409 / 31105（包已封 / 终态）。
 */
const MATERIAL_EDITABLE_STATUSES: readonly number[] = [
  MENTOR_APPLICATION_STATUS.COLLEGE_REVIEWING,
  MENTOR_APPLICATION_STATUS.COLLEGE_REJECTED,
];

/**
 * 导师佐证材料（Task 16+17）：挂接 / 列出 / 摘除 / 按申请鉴权的预览下载。
 *
 * 材料是**申请的附件**——按所属申请鉴权，不是「有 token 就能下」（R60）。
 * 文件本体的归属锚点是 `SysFile.ownerType = 'MentorApplication'` +
 * `ownerId = applicationId`（O5，PascalCase 一字不差，大小写敏感），上传走
 * `POST /files`（Task 8），本模块**不写 `SysFile` 的任何列**。
 *
 * 守卫顺序与可见性判定是「不写就会长歪」的那几行（brief §3 / §5）：
 * 先到先拒，越权时一个写都不发；读路由「申请人本人**或**数据范围覆盖申请人
 * 部门」缺一不可见——只看权限码等于把全校材料摊给任何持 `list` 的人。
 */
@Injectable()
export class MentorMaterialService {
  constructor(
    private readonly repository: MentorMaterialRepository,
    private readonly users: UserService,
    private readonly dataScope: DataScopeService,
    private readonly fileService: FileService,
  ) {}

  /**
   * `POST /mentor-applications/:id/materials` —— 挂材料。
   *
   * 守卫顺序（brief §3，先到先拒）：
   *   1. 申请不存在（含软删）→ 404 / 31104；
   *   2. 越权：不是申请人本人 → 403 / 10003（**不是** 404，要能区分
   *      「没权限」和「不存在」）；
   *   3. `personType='student'` → 403 / 10003；
   *   4. `status ∉ {2, 3}` → 409 / 31105（R62）；
   *   5. `assertOwnedBy(fileId, 'MentorApplication', applicationId)` → 404 / 28101；
   *   6. 同一 fileId 本申请下已有未删行 → 409 / 10006。
   */
  async attach(
    applicationId: bigint,
    dto: AttachMaterialDto,
    caller: RequestUser,
  ): Promise<MaterialResponseDto> {
    const application = await this.loadApplication(applicationId);
    await this.assertWritable(application, caller);

    // 归属校验：文件必须是**本申请**的附件（ownerType 精确值 O5）。
    // 不存在 / 无归属 / 归属不符三败同码同文案 404 / 28101（fileNotFound 单点构造）
    await this.fileService.assertOwnedBy(
      dto.fileId,
      'MentorApplication',
      String(applicationId),
    );

    if (
      await this.repository.hasActiveMaterial(applicationId, BigInt(dto.fileId))
    ) {
      throw this.duplicateMaterial();
    }

    const created = await this.repository.create({
      applicationId,
      kind: dto.kind,
      fileId: BigInt(dto.fileId),
    });
    const files = await this.repository.findFilesByIds([created.fileId]);
    return toMaterialResponse(created, files[0] ?? null);
  }

  /**
   * `GET /mentor-applications/:id/materials` —— 列出该申请的全部材料。
   * 全量一页（不收分页参数）：材料是申请子资源，条数有界。
   * 可见性（三条 GET 共用）：申请人本人**或**数据范围覆盖申请人部门。
   */
  async list(
    applicationId: bigint,
    caller: RequestUser,
  ): Promise<MaterialListResponseDto> {
    const application = await this.loadApplication(applicationId);
    await this.assertReadable(application, caller);

    const rows = await this.repository.findManyByApplication(applicationId);
    const files = await this.repository.findFilesByIds(
      rows.map((row) => row.fileId),
    );
    const fileById = new Map(files.map((file) => [file.id, file]));
    const list = rows.map((row) =>
      toMaterialResponse(row, fileById.get(row.fileId) ?? null),
    );
    return { list, total: list.length, page: 1, pageSize: list.length };
  }

  /**
   * `DELETE /mentor-applications/:id/materials/:materialId` —— 摘材料（软删）。
   * 守卫顺序镜像挂接：404 / 31104 → 403 越权 → 403 student → 409 / 31105
   * （status ∉ {2,3}）→ 404 / 31107（materialId 不存在 / 已软删）→ 软删。
   * 不动 `SysFile`；摘后同一 fileId 允许再挂（唯一性按未删行算）。
   */
  async remove(
    applicationId: bigint,
    materialId: bigint,
    caller: RequestUser,
  ): Promise<void> {
    const application = await this.loadApplication(applicationId);
    await this.assertWritable(application, caller);

    const material = await this.repository.findActiveById(
      applicationId,
      materialId,
    );
    if (material === null) {
      throw this.materialNotFound();
    }
    await this.repository.softDelete(material.id);
  }

  /** 预览：`Content-Disposition: inline`（按 mimeType 直接渲染） */
  async preview(
    applicationId: bigint,
    materialId: bigint,
    caller: RequestUser,
  ): Promise<StreamableFile> {
    return this.serveMaterial(applicationId, materialId, caller, 'inline');
  }

  /** 下载：`attachment`（按上传原名另存；固定 octet-stream 才会另存为） */
  async download(
    applicationId: bigint,
    materialId: bigint,
    caller: RequestUser,
  ): Promise<StreamableFile> {
    return this.serveMaterial(
      applicationId,
      materialId,
      caller,
      'attachment',
      'application/octet-stream',
    );
  }

  /**
   * 预览 / 下载共用的守卫链（brief §3）：404 / 31104 → 可见性 403 / 10003 →
   * 404 / 31107（materialId 不存在 / 已软删 / 不属于本申请，按
   * `{id, applicationId}` findFirst）→ `assertOwnedBy` 404 / 28101 → serve。
   */
  private async serveMaterial(
    applicationId: bigint,
    materialId: bigint,
    caller: RequestUser,
    disposition: 'inline' | 'attachment',
    type?: string,
  ): Promise<StreamableFile> {
    const application = await this.loadApplication(applicationId);
    await this.assertReadable(application, caller);

    const material = await this.repository.findActiveById(
      applicationId,
      materialId,
    );
    if (material === null) {
      throw this.materialNotFound();
    }

    // 挂接时校验过归属，这里再验是防 SysFile 的 owner 被改写 / fileId 被顶换。
    // 归属不符同 404 / 28101「文件不存在」——不许单开第四个分支（§2）
    await this.fileService.assertOwnedBy(
      material.fileId.toString(),
      'MentorApplication',
      String(applicationId),
    );
    return this.fileService.serve(material.fileId, disposition, type);
  }

  /** 载入申请行（含申请人 + 部门投影）；不存在 / 已软删 → 404 / 31104 */
  private async loadApplication(
    id: bigint,
  ): Promise<MaterialApplicationWithApplicant> {
    const application = await this.repository.findDetailById(id);
    if (application === null) {
      throw this.applicationNotFound();
    }
    return application;
  }

  /**
   * 挂 / 摘的守卫（brief §3 的 2-4 步）：'self' 天花板绊线 → 越权 → student →
   * 状态门。绊线（同 review.service.withdraw）：有人把 `@DataScope('self')`
   * 改宽时宁可 403 也不开宽口。
   */
  private async assertWritable(
    application: MaterialApplicationWithApplicant,
    caller: RequestUser,
  ): Promise<void> {
    const scope = await this.dataScope.resolve(
      {
        userId: caller.userId,
        isSuperAdmin: caller.isSuperAdmin,
        deptId: null,
      },
      currentDataScopeCeiling(),
    );
    if (scope.kind !== 'self' || scope.userId !== caller.userId) {
      throw this.forbidden();
    }

    const person = await this.findPerson(caller);
    if (person === null || person.id !== application.applicantId) {
      // 越权：不是申请人本人。403 不是 404——「没权限」和「不存在」要能分开
      throw this.forbidden();
    }
    if (person.personType === 'student') {
      throw new BusinessException(
        ErrorCode.FORBIDDEN,
        '只有导师（internalMentor / externalMentor）能管理佐证材料',
        HttpStatus.FORBIDDEN,
      );
    }

    if (!MATERIAL_EDITABLE_STATUSES.includes(application.status)) {
      throw this.transitionInvalid();
    }
  }

  /**
   * 三条 GET 共用的可见性断言（brief §3）：调用者是申请人本人，
   * **或**数据范围覆盖申请人部门（`assertDeptVisible(filter, 申请人部门)`）。
   * 不满足 → 403 / 10003，不是 404。申请人部门取
   * `applicant.orgUnit?.deptId ?? null`，null 时只有 `{kind:'all'}` 可见
   * （fail-closed，同 mentor-application.service 的同名判定）。
   */
  private async assertReadable(
    application: MaterialApplicationWithApplicant,
    caller: RequestUser,
  ): Promise<void> {
    const person = await this.findPerson(caller);
    if (person !== null && person.id === application.applicantId) {
      return; // 申请人本人：自己的申请自己看得见
    }
    const scope = await this.resolveScope(caller);
    const applicantDeptId = application.applicant.orgUnit?.deptId ?? null;
    if (applicantDeptId === null) {
      if (scope.kind !== 'all') {
        throw this.forbidden();
      }
      return;
    }
    this.dataScope.assertDeptVisible(scope, applicantDeptId);
  }

  /** 身份链：`caller.userId` → `SysUser.username` → `SyncPerson.login`（自然键无外键） */
  private async findPerson(caller: RequestUser): Promise<SyncPerson | null> {
    const user = await this.users.findById(caller.userId);
    return user === null
      ? null
      : await this.repository.findPersonByLogin(user.username);
  }

  /** 数据范围（同 mentor-application.service.resolveScope）：角色范围与接口上限求窄 */
  private async resolveScope(caller: RequestUser): Promise<DataScopeFilter> {
    const self = await this.users.findById(caller.userId);
    return this.dataScope.resolve(
      {
        userId: caller.userId,
        isSuperAdmin: caller.isSuperAdmin,
        deptId: self?.deptId ?? null,
      },
      currentDataScopeCeiling(),
    );
  }

  /** 403 / 10003「无权限」：越权 / 数据范围不可见共用一码一文案 */
  private forbidden(): BusinessException {
    return new BusinessException(
      ErrorCode.FORBIDDEN,
      '无权限',
      HttpStatus.FORBIDDEN,
    );
  }

  /** 409 / 31105（R62 状态门）：复用 Task 14 的码——这就是「当前状态不允许该操作」 */
  private transitionInvalid(): BusinessException {
    return new BusinessException(
      ErrorCode.MENTOR_APPLICATION_TRANSITION_INVALID,
      '当前状态不允许该操作',
      HttpStatus.CONFLICT,
    );
  }

  /** 404 / 31107：`:materialId` 不存在 / 已软删 / 不属于本申请 */
  private materialNotFound(): BusinessException {
    return new BusinessException(
      ErrorCode.MENTOR_MATERIAL_NOT_FOUND,
      '佐证材料不存在',
      HttpStatus.NOT_FOUND,
    );
  }

  /** 409 / 10006：同一 fileId 重复挂到同一申请（未删行才算重复，摘后可再挂） */
  private duplicateMaterial(): BusinessException {
    return new BusinessException(
      ErrorCode.CONFLICT,
      '同一文件不能重复挂到同一申请',
      HttpStatus.CONFLICT,
    );
  }

  /** 404 / 31104「入驻申请不存在」：复用 Task 14 的码与文案 */
  private applicationNotFound(): BusinessException {
    return new BusinessException(
      ErrorCode.MENTOR_APPLICATION_NOT_FOUND,
      '入驻申请不存在',
      HttpStatus.NOT_FOUND,
    );
  }
}
