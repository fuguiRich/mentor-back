/**
 * 错误码段位（规范 ERR-03）：
 *   0            成功
 *   10000-10999  通用
 *   20000-20999  认证 auth
 *   21000-21999  用户 user
 *   22000-22999  角色 role
 *   23000-23999  权限 permission
 *   24000-24999  部门 dept
 *   25000-25999  数据字典 dict        （S2）
 *   26000-26999  系统配置 config      （S2）
 *   27000-27999  操作日志 log         （S3）
 *   28000-28999  文件 file            （S3）
 *   29000-29999  预留
 *   30000-30999  同步 sync            （mentor-back）
 *   31000-31999  导师 mentor          （mentor-back）
 *   32000-32999  预约 appt            （mentor-back）
 *   33000-33999  指导记录 guidance    （mentor-back）
 *   34000-34999  评价 review          （mentor-back）
 *   35000-35999  考核 assessment      （mentor-back）
 *   36000-36999  成果 achieve         （mentor-back）
 *   37000-37999  归档 archive         （mentor-back）
 *   38000-38999  预留
 */
export enum ErrorCode {
  // 通用 10000-10999
  INTERNAL_ERROR = 10000,
  PARAM_INVALID = 10001,
  UNAUTHORIZED = 10002,
  FORBIDDEN = 10003,
  NOT_FOUND = 10004,
  RATE_LIMITED = 10005,
  CONFLICT = 10006,

  // 认证模块 20000-20999
  AUTH_CREDENTIALS_INVALID = 20101,
  AUTH_ACCOUNT_DISABLED = 20102,
  AUTH_LOGIN_LOCKED = 20103,
  AUTH_REFRESH_INVALID = 20104,
  AUTH_PASSWORD_MISMATCH = 20105,
  AUTH_SSO_STATE_INVALID = 20106,
  AUTH_SSO_USER_UNKNOWN = 20107,

  // 用户模块 21000-21999
  USER_NOT_FOUND = 21101,
  USER_NAME_TAKEN = 21102,
  USER_EMPLOYEE_NO_TAKEN = 21103,
  USER_MOBILE_TAKEN = 21104,
  USER_SUPER_ADMIN_PROTECTED = 21105,

  // 角色模块 22000-22999
  ROLE_NOT_FOUND = 22101,
  ROLE_CODE_TAKEN = 22102,

  // 权限模块 23000-23999
  PERMISSION_NOT_FOUND = 23101,
  PERMISSION_CODE_TAKEN = 23102,
  PERMISSION_CODE_REQUIRED = 23103,
  PERMISSION_CODE_FORBIDDEN = 23104,
  PERMISSION_PARENT_INVALID = 23105,
  PERMISSION_HAS_CHILDREN = 23106,

  // 部门模块 24000-24999
  DEPT_NOT_FOUND = 24101,
  DEPT_NAME_TAKEN = 24102,
  DEPT_HAS_CHILDREN = 24103,
  DEPT_HAS_USERS = 24104,
  DEPT_PARENT_INVALID = 24105,

  // 数据字典 25000-25999
  DICT_TYPE_NOT_FOUND = 25101,
  DICT_TYPE_CODE_TAKEN = 25102,
  DICT_TYPE_HAS_ITEMS = 25103,
  DICT_ITEM_NOT_FOUND = 25104,
  DICT_ITEM_VALUE_TAKEN = 25105,

  // 系统配置 26000-26999
  CONFIG_NOT_FOUND = 26101,
  CONFIG_CODE_TAKEN = 26102,
  CONFIG_VALUE_TYPE_INVALID = 26103,
  CONFIG_VALUE_MISMATCH = 26104,

  // 操作日志 27000-27999
  OP_LOG_NOT_FOUND = 27101,

  // 文件 28000-28999
  FILE_NOT_FOUND = 28101,
  FILE_TYPE_FORBIDDEN = 28102,
  FILE_TOO_LARGE = 28103,
  FILE_EMPTY = 28104,
  FILE_COUNT_EXCEEDED = 28105,
  FILE_MAGIC_MISMATCH = 28106,

  // 同步 30000-30999（mentor-back）
  SYNC_WRITE_FORBIDDEN = 30101,

  // 导师 31000-31999（mentor-back）
  MENTOR_ALREADY_ONBOARDED = 31101,
  MENTOR_PROFILE_NOT_FOUND = 31102,
  MENTOR_PROFILE_NOT_SUBMITTABLE = 31103,
  MENTOR_APPLICATION_NOT_FOUND = 31104,
  MENTOR_APPLICATION_TRANSITION_INVALID = 31105,
  // R58 在审去重（Task 15）：同一申请人同时只许一条在审申请
  // （status ∈ {1, 2, 4, 5}），第二个提交入口挡在 31106 上
  MENTOR_APPLICATION_IN_FLIGHT = 31106,
  // 佐证材料（Task 16+17）：`:materialId` 不存在或已软删 → 404。
  // 与 31104 分开：「申请不存在」与「材料不存在」的处置不同（后者换一条材料重试）
  MENTOR_MATERIAL_NOT_FOUND = 31107,
}

/** 各段位的 [起, 止]，供自检单测核对 */
export const ERROR_CODE_SEGMENTS: ReadonlyArray<readonly [number, number]> = [
  [10000, 10999],
  [20000, 20999],
  [21000, 21999],
  [22000, 22999],
  [23000, 23999],
  [24000, 24999],
  [25000, 25999],
  [26000, 26999],
  [27000, 27999],
  [28000, 28999],
  [29000, 29999],
  // mentor-back 业务段位（见 docs/plans/2026-10-20-mentor-p1.md Task 9）
  [30000, 30999],
  [31000, 31999],
  [32000, 32999],
  [33000, 33999],
  [34000, 34999],
  [35000, 35999],
  [36000, 36999],
  [37000, 37999],
  [38000, 38999],
];

/**
 * 每个错误码的短说明，供 OpenAPI 全局说明里的错误码表生成
 * （bootstrap.ts 的 buildSwaggerConfig）。表由此生成、不手抄——新增枚举成员
 * 而忘了补这里时，`Record<ErrorCode, string>` 会让编译直接失败。
 *
 * 文案取自运行时真实抛出点（all-exceptions.filter.ts / validation.exception.ts /
 * dept.service.ts 等）；带参数的消息（如「该部门下还有 3 个下级部门」）记为通用形式。
 * 尚无实现的 10002 / 10003 用规范第 6 章的注册短名。
 */
export const ERROR_CODE_DESCRIPTIONS: Record<ErrorCode, string> = {
  [ErrorCode.INTERNAL_ERROR]: '服务器内部错误',
  [ErrorCode.PARAM_INVALID]: '参数校验失败',
  [ErrorCode.UNAUTHORIZED]: '未认证',
  [ErrorCode.FORBIDDEN]: '无权限',
  [ErrorCode.NOT_FOUND]: '资源不存在',
  [ErrorCode.RATE_LIMITED]: '请求过于频繁',
  [ErrorCode.CONFLICT]: '数据冲突，请刷新后重试',
  [ErrorCode.AUTH_CREDENTIALS_INVALID]: '用户名或密码错误',
  [ErrorCode.AUTH_ACCOUNT_DISABLED]: '账号已停用，请联系管理员',
  [ErrorCode.AUTH_LOGIN_LOCKED]: '登录失败次数过多，请稍后再试',
  [ErrorCode.AUTH_REFRESH_INVALID]: '登录状态已失效，请重新登录',
  [ErrorCode.AUTH_PASSWORD_MISMATCH]: '原密码错误',
  [ErrorCode.AUTH_SSO_STATE_INVALID]: '统一认证未通过，请重新发起登录',
  [ErrorCode.AUTH_SSO_USER_UNKNOWN]:
    '统一认证已通过，但本系统没有对应账号，请联系管理员',
  [ErrorCode.USER_NOT_FOUND]: '用户不存在',
  [ErrorCode.USER_NAME_TAKEN]: '用户名已存在',
  [ErrorCode.USER_EMPLOYEE_NO_TAKEN]: '工号已存在',
  [ErrorCode.USER_MOBILE_TAKEN]: '手机号已存在',
  [ErrorCode.USER_SUPER_ADMIN_PROTECTED]: '超级管理员受保护，不能执行该操作',
  [ErrorCode.ROLE_NOT_FOUND]: '角色不存在',
  [ErrorCode.ROLE_CODE_TAKEN]: '角色编码已存在',
  [ErrorCode.PERMISSION_NOT_FOUND]: '权限点不存在',
  [ErrorCode.PERMISSION_CODE_TAKEN]: '权限码已存在',
  [ErrorCode.PERMISSION_CODE_REQUIRED]: '菜单与按钮类型必须设置权限码',
  [ErrorCode.PERMISSION_CODE_FORBIDDEN]: '目录类型不能设置权限码',
  [ErrorCode.PERMISSION_PARENT_INVALID]: '上级权限点不能是自己或自己的下级',
  [ErrorCode.PERMISSION_HAS_CHILDREN]: '该权限点下还有下级，请先移走或删除',
  [ErrorCode.DEPT_NOT_FOUND]: '部门不存在',
  [ErrorCode.DEPT_NAME_TAKEN]: '同级下已存在同名部门',
  [ErrorCode.DEPT_HAS_CHILDREN]: '该部门下还有下级部门，请先移走或删除',
  [ErrorCode.DEPT_HAS_USERS]: '该部门下还有用户，请先调整他们的归属',
  [ErrorCode.DEPT_PARENT_INVALID]: '上级部门不能是自己或自己的下级部门',
  [ErrorCode.DICT_TYPE_NOT_FOUND]: '字典类型不存在',
  [ErrorCode.DICT_TYPE_CODE_TAKEN]: '字典类型编码已存在',
  [ErrorCode.DICT_TYPE_HAS_ITEMS]: '该字典类型下还有字典项，请先移走或删除',
  [ErrorCode.DICT_ITEM_NOT_FOUND]: '字典项不存在',
  [ErrorCode.DICT_ITEM_VALUE_TAKEN]: '同字典类型下已存在相同的字典值',
  [ErrorCode.CONFIG_NOT_FOUND]: '系统配置不存在',
  [ErrorCode.CONFIG_CODE_TAKEN]: '系统配置编码已存在',
  [ErrorCode.CONFIG_VALUE_TYPE_INVALID]:
    '配置值类型只能是 string / number / boolean / json',
  [ErrorCode.CONFIG_VALUE_MISMATCH]: '配置值与声明的类型不符',
  [ErrorCode.OP_LOG_NOT_FOUND]: '操作日志不存在',
  [ErrorCode.FILE_NOT_FOUND]: '文件不存在',
  [ErrorCode.FILE_TYPE_FORBIDDEN]: '不支持的文件类型',
  [ErrorCode.FILE_TOO_LARGE]: '文件超出大小上限',
  [ErrorCode.FILE_EMPTY]: '上传内容为空',
  [ErrorCode.FILE_COUNT_EXCEEDED]: '一次上传的文件数超限',
  [ErrorCode.FILE_MAGIC_MISMATCH]: '文件内容与扩展名不符',
  [ErrorCode.SYNC_WRITE_FORBIDDEN]: '同步层的表由同步任务维护，不接受业务写入',
  [ErrorCode.MENTOR_ALREADY_ONBOARDED]: '导师已入驻，不能重复提交入驻申请',
  [ErrorCode.MENTOR_PROFILE_NOT_FOUND]: '导师专业档案不存在',
  // 31103 跨两个入口（R69 定稿）：PUT 的 R55 门运行时按 status 分支
  // （在审 / 已生效 / 已冻结 / 已移除），提交入驻的门统一用这一句。
  [ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE]:
    '导师档案当前状态不允许提交入驻申请',
  [ErrorCode.MENTOR_APPLICATION_NOT_FOUND]: '入驻申请不存在',
  [ErrorCode.MENTOR_APPLICATION_TRANSITION_INVALID]: '当前状态不允许该操作',
  // 31106 与 31103 分流（R58）：「档案状态不对」和「已有在审申请」的处置不同，
  // 后者是「去把那条撤了」，前端要能分开提示
  [ErrorCode.MENTOR_APPLICATION_IN_FLIGHT]: '已有在审的申请，不能重复提交',
  [ErrorCode.MENTOR_MATERIAL_NOT_FOUND]: '佐证材料不存在',
};
