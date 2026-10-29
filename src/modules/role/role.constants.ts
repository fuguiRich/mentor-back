/**
 * 角色编码格式：小写字母开头，可含数字与下划线。
 * **下划线是刻意放行的**——prisma/seed.ts 种的内置角色编码是 `super_admin`，
 * 换成中划线要连种子一起改，收益为零。
 * 这不是权限码格式（那是 `<资源>:<动作>`，见 permission.constants.ts）：两者用途不同，
 * 角色编码是稳定的机器标识，将来可能出现在 `hasRole('super_admin')` 这类判断里。
 */
export const ROLE_CODE_PATTERN = /^[a-z][a-z0-9_]*$/;
