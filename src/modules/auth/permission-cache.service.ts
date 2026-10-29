import { Injectable } from '@nestjs/common';
import { SessionStore } from '../../infra/redis/session-store.service';
import { PermissionService } from '../permission/permission.service';

/**
 * 权限码缓存的唯一入口（cache-aside）。
 *
 * 缓存未命中就回源并写回——这是 spec 第 7 节「角色权限变更时删 key，下次请求自动回填」
 * 里"自动"两个字的实现。若只在登录时写缓存，Redis 一旦驱逐该键，用户会**合法地**
 * 拿到 403（而令牌仍然有效）——这类"权限莫名其妙没了、重新登录又好了"的现象最难定位。
 */
@Injectable()
export class PermissionCacheService {
  constructor(
    private readonly sessions: SessionStore,
    private readonly permissions: PermissionService,
  ) {}

  async load(userId: bigint): Promise<readonly string[]> {
    const cached = await this.sessions.getPermissions(userId);
    if (cached !== null) {
      return cached;
    }

    const codes = await this.permissions.findCodesByUserId(userId);
    await this.sessions.setPermissions(userId, codes);
    return codes;
  }
}
