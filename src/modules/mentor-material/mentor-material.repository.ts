import { Injectable } from '@nestjs/common';
import type {
  MentorApplication,
  MentorApplicationMaterial,
  SyncOrgUnit,
  SyncPerson,
  SysFile,
} from '@prisma/client';
import { currentActorId } from '../../common/context/request-context';
import { PrismaService } from '../../infra/prisma/prisma.service';

/**
 * 申请行 + 申请人 + 申请人部门投影（可见性按**申请人部门**判越权）。
 * 形状同 mentor-application.repository 的 `MentorApplicationWithApplicant`，
 * 本地复述而不跨模块引类型——类型不该是模块间的耦合点，运行时更没有。
 * `orgUnit` 可能为 null 或 `deptId` 为 null：都当「没有可见部门」（fail-closed）。
 */
export type MaterialApplicationWithApplicant = MentorApplication & {
  applicant: SyncPerson & { orgUnit: SyncOrgUnit | null };
};

/**
 * 佐证材料的数据访问（外加身份链与文件元数据两条只读）。
 *
 * `SyncPerson` 的**读**在这里做是刻意的（同 mentor-application.repository 的
 * 理由）：身份链（username ↔ login）是本模块判「是不是申请人本人」的脊梁，
 * 而 SyncModule 不导出它的 repository。**写**仍被 `SYNC_WRITE_FORBIDDEN =
 * 30101` 拒掉，本文件只有 findFirst。
 *
 * 读一律 `findFirst`（ESLint 禁 `findUnique`：软删除表塞不进 deletedAt 过滤）。
 */
@Injectable()
export class MentorMaterialRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 身份链第 2 步：SysUser.username → SyncPerson（自然键 login，精确匹配） */
  async findPersonByLogin(login: string): Promise<SyncPerson | null> {
    return this.prisma.client.syncPerson.findFirst({ where: { login } });
  }

  /** 申请行 + 申请人 + 部门投影（软删行查不出 → 404 / 31104） */
  async findDetailById(
    id: bigint,
  ): Promise<MaterialApplicationWithApplicant | null> {
    return this.prisma.client.mentorApplication.findFirst({
      where: { id },
      include: { applicant: { include: { orgUnit: true } } },
    });
  }

  /** 本申请的全部**未删**材料（挂接序，id asc）。软删行被读过滤天然滤掉 */
  async findManyByApplication(
    applicationId: bigint,
  ): Promise<MentorApplicationMaterial[]> {
    return this.prisma.client.mentorApplicationMaterial.findMany({
      where: { applicationId },
      orderBy: [{ id: 'asc' }],
    });
  }

  /**
   * `:materialId` 必须**同时**命中 `{ id, applicationId }`——挂在别的申请下的
   * 材料不算本申请的（404 / 31107，不暴露「这条材料确实存在」）。
   */
  async findActiveById(
    applicationId: bigint,
    id: bigint,
  ): Promise<MentorApplicationMaterial | null> {
    return this.prisma.client.mentorApplicationMaterial.findFirst({
      where: { id, applicationId },
    });
  }

  /**
   * 重复挂检查：同一 `fileId` 在本申请下已有**未删**行。
   * 「唯一性按未删行算」靠读过滤天然成立——摘掉（软删）之后同一 fileId 允许再挂。
   */
  async hasActiveMaterial(
    applicationId: bigint,
    fileId: bigint,
  ): Promise<boolean> {
    const count = await this.prisma.client.mentorApplicationMaterial.count({
      where: { applicationId, fileId },
    });
    return count > 0;
  }

  /** 挂材料落一行。createdBy / updatedBy 是类型占位，扩展按当前操作者重写（DB-05） */
  async create(data: {
    applicationId: bigint;
    kind: number;
    fileId: bigint;
  }): Promise<MentorApplicationMaterial> {
    return this.prisma.client.mentorApplicationMaterial.create({
      data: {
        applicationId: data.applicationId,
        kind: data.kind,
        fileId: data.fileId,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
  }

  /**
   * 摘材料 = 软删（R63）：显式 `update` 打 `deletedAt` / `deletedBy`——
   * 扩展拒 delete/deleteMany（R24），软删写在 repository 是唯一合法形态
   * （DeptRepository.softDelete / FileRepository.softDelete 先例）。
   * **不动 `SysFile`**：文件行还在，同一 fileId 允许再挂（判据 16）。
   */
  async softDelete(id: bigint): Promise<void> {
    await this.prisma.client.mentorApplicationMaterial.update({
      where: { id },
      // updatedAt / updatedBy 由扩展补，这里只写软删除标记本身（DeptRepository 同款）
      data: { deletedAt: new Date(), deletedBy: currentActorId() },
    });
  }

  /**
   * 材料行引用的文件元数据（文件名 / 大小 / MIME 展示用）。
   * **只读** `SysFile`——「本任务不写 SysFile 的任何列」（brief §4），
   * 文件的创建与删除都走 FileModule 的接口。走 client（滤软删行）：
   * 文件被删后列表兜底空元数据（mapper），不冒充文件名。
   */
  async findFilesByIds(ids: readonly bigint[]): Promise<SysFile[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.prisma.client.sysFile.findMany({
      where: { id: { in: [...ids] } },
    });
  }
}
