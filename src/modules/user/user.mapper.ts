import type { UserWithDeptName } from './user.repository';
import { UserDetailResponseDto } from './dto/user-detail-response.dto';
import { UserResponseDto } from './dto/user-response.dto';

/**
 * 实体 → Response DTO 的显式映射（规范 RES-04）。
 * **永远不输出 password**——这个函数是密码不出现在任何响应里的唯一保证，
 * 加字段时先想清楚它会不会把口令带出去。
 */
export function toUserResponse(entity: UserWithDeptName): UserResponseDto {
  return {
    id: entity.id.toString(),
    username: entity.username,
    realName: entity.realName,
    employeeNo: entity.employeeNo,
    mobile: entity.mobile,
    deptId: entity.deptId.toString(),
    deptName: entity.dept.name,
    status: entity.status,
    isSuperAdmin: entity.isSuperAdmin,
    authSource: entity.authSource as 'local' | 'sso',
    lastLoginAt: entity.lastLoginAt?.toISOString() ?? null,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
    createdBy: entity.createdBy.toString(),
    updatedBy: entity.updatedBy.toString(),
  };
}

export function toUserDetailResponse(
  entity: UserWithDeptName,
  roleIds: bigint[],
): UserDetailResponseDto {
  return {
    ...toUserResponse(entity),
    roleIds: roleIds.map((id) => id.toString()),
  };
}
