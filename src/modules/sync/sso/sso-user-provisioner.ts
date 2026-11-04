import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorCode } from '../../../common/constants/error-code';
import { BusinessException } from '../../../common/errors/business.exception';
import { runWithSyncWrite } from '../../../infra/prisma/sync-write-scope';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import type { AppConfig } from '../../../config/configuration';
import { ProjectionWriter } from '../projection';
import { SyncOrgRepository } from '../sync-org.repository';
import { SyncPersonRepository } from '../sync-person.repository';
import { PERSON_TYPE_ROLE_CODE } from '../sync.constants';

export interface SsoProvisionInput {
  login: string;
  realName: string;
  userType: 'teacher' | 'student';
  deptId: string | null;
  deptName: string | null;
  passwordHash: string;
}

/**
 * 首次 SSO 登录时把「源系统的人」落成本地账号。
 *
 * 为什么不在 AuthService 里直接写库：`SyncPerson` / `SyncOrgUnit` 受
 * `SYNC_WRITE_FORBIDDEN` 守卫保护，写入口必须统一收在同步模块里，并且包进
 * `runWithSyncWrite`。登录 provisioning 是源系统数据的合法写入口，不是业务越权。
 *
 * **`resolveDeptId` 只读**：登录回写部门时若映射不到，保留原部门即可，
 * 不能为了一个部门字段在请求链路里创建同步层数据。
 */
@Injectable()
export class SsoUserProvisioner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgs: SyncOrgRepository,
    private readonly persons: SyncPersonRepository,
    private readonly projection: ProjectionWriter,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** 只读映射：`sso:<deptId>` 优先，其次唯一部门名；都找不到返回 null */
  async resolveDeptId(
    deptId: string | null,
    deptName: string | null,
  ): Promise<bigint | null> {
    if (deptId !== null && deptId !== '') {
      const unit = await this.orgs.findByCode(`sso:${deptId}`);
      if (unit?.deptId != null) {
        const dept = await this.projection.findDept(unit.deptId);
        if (dept !== null && dept.deletedAt === null) {
          return dept.id;
        }
      }
    }

    if (deptName !== null && deptName !== '') {
      const matches = await this.prisma.client.sysDept.findMany({
        where: { name: deptName, deletedAt: null },
        take: 2,
      });
      if (matches.length === 1) {
        return matches[0].id;
      }
    }

    return null;
  }

  async ensureUser(input: SsoProvisionInput): Promise<{ userId: bigint }> {
    return runWithSyncWrite(async () => {
      const root = await this.projection.findRootDept();
      const orgUnitId = await this.ensureOrgUnit(input, root?.id ?? null);
      const deptId = await this.resolveDeptIdForProvisioning(
        input,
        orgUnitId,
        root?.id ?? null,
      );

      if (deptId === null) {
        throw new BusinessException(
          ErrorCode.AUTH_SSO_PROVISION_FAILED,
          '统一认证已通过，但本地账号创建失败：没有可用部门',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      await this.ensurePerson(input, orgUnitId);

      const existing = await this.projection.findUser(input.login);
      const user =
        existing === null
          ? await this.createUser(input, deptId)
          : await this.updateUser(existing, input, deptId);

      await this.ensureDefaultRole(user.id, input.userType);
      return { userId: user.id };
    });
  }

  private async ensureOrgUnit(
    input: SsoProvisionInput,
    rootDeptId: bigint | null,
  ): Promise<bigint> {
    const code =
      input.deptId !== null && input.deptId !== ''
        ? `sso:${input.deptId}`
        : `sso:dept:${input.deptName ?? 'root'}`;

    const existing = await this.orgs.findByCode(code);
    if (existing !== null) {
      if (existing.deptId !== null) {
        return existing.id;
      }
      const dept = await this.projection.createDept({
        name: input.deptName ?? '统一认证用户',
        parentId: rootDeptId,
        sortOrder: 0,
        status: 1,
        remark: 'SSO 登录自动建号',
      });
      await this.orgs.linkDept(existing, dept.id);
      return existing.id;
    }

    const unit = await this.orgs.create(code, {
      name: input.deptName ?? '统一认证用户',
      kind: 'department',
      syncedAt: new Date(),
      syncRunId: null,
    });
    const dept = await this.projection.createDept({
      name: input.deptName ?? '统一认证用户',
      parentId: rootDeptId,
      sortOrder: 0,
      status: 1,
      remark: 'SSO 登录自动建号',
    });
    await this.orgs.linkDept(unit, dept.id);
    return unit.id;
  }

  private async resolveDeptIdForProvisioning(
    input: SsoProvisionInput,
    orgUnitId: bigint,
    rootDeptId: bigint | null,
  ): Promise<bigint | null> {
    const mapped = await this.resolveDeptId(input.deptId, input.deptName);
    if (mapped !== null) {
      return mapped;
    }

    // 刚建出来的 org unit 已经有 deptId；直接读它
    const unit = await this.orgs.findById(orgUnitId);
    if (unit?.deptId != null) {
      return unit.deptId;
    }

    const defaultCode = this.config.get('sso.syncDefaultDeptCode', {
      infer: true,
    });
    if (defaultCode !== '') {
      const unit = await this.orgs.findByCode(defaultCode);
      if (unit?.deptId != null) {
        return unit.deptId;
      }
    }

    return rootDeptId;
  }

  private async ensurePerson(
    input: SsoProvisionInput,
    orgUnitId: bigint,
  ): Promise<void> {
    const existing = await this.persons.findByLogin(input.login);
    if (existing !== null) {
      return;
    }
    await this.persons.create(input.login, {
      realName: input.realName,
      personType: input.userType,
      orgUnitId,
      major: null,
      className: null,
      mobile: null,
      syncedAt: new Date(),
      syncRunId: null,
    });
  }

  private async createUser(
    input: SsoProvisionInput,
    deptId: bigint,
  ): Promise<{ id: bigint; status: number }> {
    const created = await this.projection.createUser({
      username: input.login,
      employeeNo: input.login,
      realName: input.realName,
      mobile: null,
      deptId,
      authSource: 'sso',
    });
    // createUser 写的是随机密码；这里用本次登录的明文哈希覆盖，
    // 让 SSO 故障时本地密码能兜底。
    await this.projection.updatePassword(created.id, input.passwordHash);
    return created;
  }

  private async updateUser(
    existing: {
      id: bigint;
      status: number;
      username: string;
      employeeNo: string;
      realName: string;
      mobile: string | null;
      deptId: bigint;
      deletedAt: Date | null;
    },
    input: SsoProvisionInput,
    deptId: bigint,
  ): Promise<{ id: bigint; status: number }> {
    if (existing.status !== 1) {
      throw new BusinessException(
        ErrorCode.AUTH_ACCOUNT_DISABLED,
        '账号已停用，请联系管理员',
        HttpStatus.UNAUTHORIZED,
      );
    }
    await this.projection.updateUser(existing, {
      username: existing.username,
      employeeNo: existing.employeeNo,
      realName: input.realName,
      mobile: existing.mobile,
      deptId,
      authSource: 'sso',
    });
    return existing;
  }

  private async ensureDefaultRole(
    userId: bigint,
    userType: 'teacher' | 'student',
  ): Promise<void> {
    if ((await this.projection.countUserRoles(userId)) > 0) {
      return;
    }
    const roleCode = PERSON_TYPE_ROLE_CODE[userType];
    const roleId = await this.projection.findRoleIdByCode(roleCode);
    if (roleId === null) {
      throw new BusinessException(
        ErrorCode.AUTH_SSO_PROVISION_FAILED,
        `统一认证已通过，但默认角色 ${roleCode} 不存在`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    await this.projection.bindRole(userId, roleId);
  }
}
