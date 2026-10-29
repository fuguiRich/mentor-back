/**
 * 权限点类型（spec 第 7 节）：DIR 仅用于前端菜单分组、不对应接口；
 * MENU 是页面；BUTTON 对应接口的写操作。库里是 VARCHAR(10) 而不是枚举
 * （schema.prisma 的刻意选择），这里的三元组是唯一真源——DTO 的 @IsIn、
 * 响应 DTO 的 enum 都从它展开，不各写一份字面量。
 */
export const PERMISSION_TYPES = ['DIR', 'MENU', 'BUTTON'] as const;
export type PermissionType = (typeof PERMISSION_TYPES)[number];

/**
 * 权限码格式 `<资源>:<动作>`（spec 第 7 节）：小写字母开头，段内可含数字与中划线，
 * 恰好一个冒号。资源名是**单数**（user 不是 users）——权限码标识"资源类型"，
 * URL 里的复数标识"资源集合"，两者本就不同。
 */
export const PERMISSION_CODE_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;
