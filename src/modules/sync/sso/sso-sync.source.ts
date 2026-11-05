import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../../config/configuration';
import type {
  SyncOrgUnitRow,
  SyncPersonRow,
  SyncRetirementScope,
  SyncSource,
} from '../contract/sync-source';
import { SsoOpenApiClient } from './sso-open-api.client';
import type { SsoOrgDept } from './sso-open-api.types';

/**
 * SSO 数据开放接口 → `SyncSource` 契约。
 *
 * 两个映射是这里最容易错的地方：
 * - 教师接口只给 `organization`（部门**名称**），没有 deptId；
 * - 学生接口的 `organization` 是**班级名称**，要先经 `/open/edu/classes`
 *   映射到学院，再映射到部门。
 *
 * 映射不到时不猜，返回 `unresolved:...`，让 `SyncService` 记 `org_not_found`
 * 并在 `SyncRun.detail` 里可见。
 */
@Injectable()
export class SsoSyncSource implements SyncSource {
  readonly name = 'sso';
  readonly retirementScope: SyncRetirementScope = {
    orgCodePrefix: 'sso:',
    personTypes: ['teacher', 'student'],
    authSources: ['sso'],
  };
  readonly reuseRootDept = true;

  private readonly logger = new Logger(SsoSyncSource.name);
  /** 调度器/手动入口在每次跑之前写入；null = 用环境变量默认值 */
  private studentsEnabledOverride: boolean | null = null;

  constructor(
    private readonly client: SsoOpenApiClient,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** 运行期设置（数据库 SysConfig）优先于环境变量 */
  setStudentsEnabled(enabled: boolean): void {
    this.studentsEnabledOverride = enabled;
  }

  async fetchOrgUnits(_since: Date | null): Promise<SyncOrgUnitRow[]> {
    const tree = await this.client.getOrgDepartments();
    const rows: SyncOrgUnitRow[] = [];

    const walk = (nodes: SsoOrgDept[], depth: number): void => {
      for (const node of nodes) {
        rows.push({
          code: `sso:${node.deptId}`,
          name: node.deptName,
          parentCode:
            node.parentId === '0' || node.parentId === ''
              ? null
              : `sso:${node.parentId}`,
          kind: depth === 0 ? 'root' : depth === 1 ? 'college' : 'department',
        });
        const children = Array.isArray(node.children) ? node.children : [];
        walk(children, depth + 1);
      }
    };

    walk(tree, 0);
    return rows;
  }

  async fetchPersons(since: Date | null): Promise<SyncPersonRow[]> {
    const orgTree = await this.client.getOrgDepartments();
    const deptCodeByName = new Map<string, string>();
    const indexDept = (nodes: SsoOrgDept[]): void => {
      for (const node of nodes) {
        if (!deptCodeByName.has(node.deptName)) {
          deptCodeByName.set(node.deptName, `sso:${node.deptId}`);
        }
        const children = Array.isArray(node.children) ? node.children : [];
        indexDept(children);
      }
    };
    indexDept(orgTree);

    const studentsEnabled = this.config.getOrThrow('sso.syncStudentsEnabled', {
      infer: true,
    });
    const classMap = new Map<
      string,
      { collegeName: string; major: string | null }
    >();
    if (studentsEnabled) {
      const classes = await this.client.getClasses();
      for (const item of classes) {
        classMap.set(item.class_name, {
          collegeName: item.college_name,
          major: item.major_name ?? null,
        });
      }
    } else {
      this.logger.warn(
        'SSO_SYNC_STUDENTS_ENABLED=false：本次只同步组织与教师，学生跳过',
      );
    }

    const teachers = await this.client.getTeachers(since);
    const students = studentsEnabled
      ? await this.client.getStudents(since)
      : [];

    const rows: SyncPersonRow[] = teachers.map((teacher) => ({
      login: teacher.workId,
      realName: teacher.name,
      personType: 'teacher',
      orgUnitCode:
        deptCodeByName.get(teacher.organization) ??
        `unresolved:teacher:${teacher.organization}`,
      major: null,
      className: null,
      mobile: null,
    }));

    for (const student of students) {
      const classInfo = classMap.get(student.organization);
      const collegeName = classInfo?.collegeName ?? student.organization;
      rows.push({
        login: student.studentId,
        realName: student.name,
        personType: 'student',
        orgUnitCode:
          deptCodeByName.get(collegeName) ??
          `unresolved:student:${student.organization}`,
        major: classInfo?.major ?? null,
        className: student.organization,
        mobile: null,
      });
    }

    const unresolved = rows.filter((row) =>
      row.orgUnitCode.startsWith('unresolved:'),
    );
    if (unresolved.length > 0) {
      this.logger.warn(
        `SSO 同步有 ${unresolved.length} 人未映射到部门（将记 org_not_found）`,
      );
    }

    return rows;
  }
}
