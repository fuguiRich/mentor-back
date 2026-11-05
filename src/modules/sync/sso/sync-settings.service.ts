import { Injectable } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';
import type { AppConfig } from '../../../config/configuration';
import { ConfigService as SysConfigService } from '../../config/config.service';

export interface SyncSettings {
  enabled: boolean;
  intervalSeconds: number;
  fullIntervalSeconds: number;
  studentsEnabled: boolean;
}

export interface UpdateSyncSettingsInput {
  enabled?: boolean;
  intervalSeconds?: number;
  fullIntervalSeconds?: number;
  studentsEnabled?: boolean;
}

/** `SysConfig` 里的键。环境变量是默认值，数据库值优先 */
const KEYS = {
  enabled: 'sync.sso.enabled',
  intervalSeconds: 'sync.sso.interval_seconds',
  fullIntervalSeconds: 'sync.sso.full_interval_seconds',
  studentsEnabled: 'sync.sso.students_enabled',
} as const;

/**
 * 同步任务的运行期设置。
 *
 * 读：数据库 `SysConfig` 优先，缺项回退到环境变量（`SSO_SYNC_*`）。
 * 写：管理接口只写 `SysConfig`，不改进程环境；调度器随后 `reschedule()`。
 */
@Injectable()
export class SyncSettingsService {
  constructor(
    private readonly env: NestConfigService<AppConfig, true>,
    private readonly sysConfig: SysConfigService,
  ) {}

  async getSettings(): Promise<SyncSettings> {
    return {
      enabled: await this.sysConfig.getBoolean(
        KEYS.enabled,
        this.env.get('sso.syncEnabled', { infer: true }),
      ),
      intervalSeconds: await this.sysConfig.getNumber(
        KEYS.intervalSeconds,
        this.env.get('sso.syncIntervalSeconds', { infer: true }),
      ),
      fullIntervalSeconds: await this.sysConfig.getNumber(
        KEYS.fullIntervalSeconds,
        this.env.get('sso.syncFullIntervalSeconds', { infer: true }),
      ),
      studentsEnabled: await this.sysConfig.getBoolean(
        KEYS.studentsEnabled,
        this.env.get('sso.syncStudentsEnabled', { infer: true }),
      ),
    };
  }

  async updateSettings(input: UpdateSyncSettingsInput): Promise<SyncSettings> {
    if (input.enabled !== undefined) {
      await this.sysConfig.setBoolean(
        KEYS.enabled,
        'SSO 同步开关',
        input.enabled,
      );
    }
    if (input.intervalSeconds !== undefined) {
      await this.sysConfig.setNumber(
        KEYS.intervalSeconds,
        'SSO 同步间隔（秒）',
        input.intervalSeconds,
      );
    }
    if (input.fullIntervalSeconds !== undefined) {
      await this.sysConfig.setNumber(
        KEYS.fullIntervalSeconds,
        'SSO 全量同步间隔（秒）',
        input.fullIntervalSeconds,
      );
    }
    if (input.studentsEnabled !== undefined) {
      await this.sysConfig.setBoolean(
        KEYS.studentsEnabled,
        'SSO 是否同步学生',
        input.studentsEnabled,
      );
    }
    return this.getSettings();
  }
}
