/**
 * 角色编码格式：小写字母开头，可含数字与下划线。
 * **下划线是刻意放行的**——prisma/seed.ts 种的内置角色编码是 `super_admin`，
 * 换成中划线要连种子一起改，收益为零。
 * 这不是权限码格式（那是 `<资源>:<动作>`，见 permission.constants.ts）：两者用途不同，
 * 角色编码是稳定的机器标识，将来可能出现在 `hasRole('super_admin')` 这类判断里。
 */
export const ROLE_CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * 内置「超级管理员」角色 code。
 *
 * 它同时是前端可见的角色，也是 `SysUser.isSuperAdmin` 标志的同步锚点：
 * 授予 / 摘除该角色时，服务层会同步布尔标志；删除 / 改 code / 停用该角色
 * 一律拒绝（22103）。
 */
export const SUPER_ADMIN_ROLE_CODE = 'super_admin';

export function isSuperAdminRoleCode(code: string | null): boolean {
  return code === SUPER_ADMIN_ROLE_CODE;
}
