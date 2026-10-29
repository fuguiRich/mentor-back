import { Module } from '@nestjs/common';
import { DataScopeModule } from '../data-scope/data-scope.module';
import { DeptModule } from '../dept/dept.module';
import { RoleModule } from '../role/role.module';
import { UserController } from './user.controller';
import { UserRepository } from './user.repository';
import { UserService } from './user.service';

/**
 * 依赖 RoleModule / DeptModule 是 spec 第 4 节的方向（user → role、user → dept）：
 * 分配角色与按角色筛选走 RoleService（sys_user_role 归 role 模块），校验部门存在
 * 走 DeptService。不要在本模块直接读 sys_user_role 或 sys_dept 的表。
 *
 * DataScopeModule 是本模块的**下游消费者**方向（user → data-scope → role/dept）：
 * 列表要按数据范围裁行。反过来让 data-scope 依赖 user 会成环，见 data-scope.module.ts。
 */
@Module({
  imports: [RoleModule, DeptModule, DataScopeModule],
  controllers: [UserController],
  providers: [UserService, UserRepository],
  exports: [UserService, UserRepository],
})
export class UserModule {}
