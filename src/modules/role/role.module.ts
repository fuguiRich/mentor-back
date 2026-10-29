import { Module } from '@nestjs/common';
import { PermissionModule } from '../permission/permission.module';
import { RoleController } from './role.controller';
import { RoleRepository } from './role.repository';
import { RoleService } from './role.service';

/**
 * 依赖 PermissionModule 是 spec 第 4 节的方向（user → role → permission）：
 * 分配权限时要校验权限点存在，走 PermissionService.assertExists，
 * 错误码归权限段。不要在本模块直接读 sys_permission。
 */
@Module({
  imports: [PermissionModule],
  controllers: [RoleController],
  providers: [RoleService, RoleRepository],
  exports: [RoleService, RoleRepository],
})
export class RoleModule {}
