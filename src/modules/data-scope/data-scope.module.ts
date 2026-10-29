import { Module } from '@nestjs/common';
import { DeptModule } from '../dept/dept.module';
import { RoleModule } from '../role/role.module';
import { DataScopeService } from './data-scope.service';

/**
 * 只依赖 role 与 dept：谁持有哪个范围在 sys_user_role / sys_role.data_scope，
 * 范围展开成部门子树要走 dept。**不依赖 UserModule**——UserModule 是本服务的
 * 调用方，反向依赖会让模块图成环（见 data-scope.service.ts 顶部注释）。
 */
@Module({
  imports: [RoleModule, DeptModule],
  providers: [DataScopeService],
  exports: [DataScopeService],
})
export class DataScopeModule {}
