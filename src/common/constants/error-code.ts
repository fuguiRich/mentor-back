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
  AUTH_SSO_UNAVAILABLE = 20108,
  AUTH_SSO_CONFIG_INVALID = 20109,
  AUTH_SSO_RATE_LIMITED = 20110,
  AUTH_SSO_RESPONSE_INVALID = 20111,
  AUTH_SSO_PASSWORD_MANAGED = 20112,
  AUTH_SSO_PROVISION_FAILED = 20113,

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

  // 导师时段 31200-31299（落在 31000-31999 导师段内）。
  // 预约域在 32000-32999、指导记录在 33000-33999，见文件头段位表。
  // 时段（Task 21）：`:id` 不存在 / 已软删 / 不属于本人一律 404——**不是 403**，
  // 别人的时段也要藏住存在性（与预约处理的 31204 刻意相反）。
  MENTOR_SLOT_NOT_FOUND = 31201,
  // 时段已关闭 / 与期望时间不符（R15）：Task 23 发起预约时，时段 status=0、
  // 或 requestedTime 的 weekday / 时段区间对不上 → 409。
  MENTOR_SLOT_UNAVAILABLE = 31202,
  // 同一导师同一 weekday 的时段区间相交 → 409。判相交用半开区间 [start, end)：
  // 09:00-11:00 与 11:00-12:00 首尾相接，不算冲突。
  // 预约冲突是另一件事，见下面的 32004 APPOINTMENT_SLOT_CONFLICT（预约段）。
  MENTOR_SLOT_OVERLAP = 31206,

  // 预约 32000-32999（mentor-back，P2 预约域）。
  // Task 23 只用到 32003 / 32004；32001 / 32002 是 Task 24-28 的码，先占位。
  // `:id` 不存在 → 404；不是本人 / 不在数据范围 → 403（与时段「藏存在性」相反）。
  APPOINTMENT_NOT_FOUND = 32001,
  APPOINTMENT_FORBIDDEN = 32002,
  // 状态机不允许该操作（R12 合法迁移表之外）→ 409。Task 23 借它表示
  // 「同一学生对同一导师已有未终态预约」这条去重守卫。
  APPOINTMENT_TRANSITION_INVALID = 32003,
  // 该时段已被未终态预约占用（R15 的冲突面）→ 409。
  APPOINTMENT_SLOT_CONFLICT = 32004,
  // 预约材料 / 过程材料的 `:materialId` 不存在或已软删 → 404。
  // 与 32001 分开：「预约不存在」与「材料不存在」的处置不同（后者换一条材料重试）。
  // 这是**预约材料**专用的码；过程材料用 33002（指导记录段）。
  APPOINTMENT_MATERIAL_NOT_FOUND = 32005,
  // 同一 fileId 重复挂到同一预约 / 同一记录 → 409。
  // 服务层的「先查后插」给这个码；并发双发时 DB-11 生成列唯一键（P2002）兜底，
  // 同样映射到这里——两条路径同码，前端只需处理一种「已挂接」。
  APPOINTMENT_MATERIAL_DUPLICATE = 32006,

  // 指导记录 33000-33999（mentor-back，P2 指导记录域）。
  // Task 26 的 `GET /appointments/:id/record`：记录尚未填报 / 已软删 → 404。
  GUIDANCE_RECORD_NOT_FOUND = 33001,
  // **过程材料**（GuidanceMaterial）的 `:materialId` 不存在 / 已软删 → 404。
  // 与 32005 分开：预约侧沿用「预约材料不存在」，过程材料是另一张表、另一句文案。
  GUIDANCE_MATERIAL_NOT_FOUND = 33002,

  // 评价 34000-34999（mentor-back，P3 评价域）。
  // `GET /appointments/:id/review`：该预约还没评价 → 404。
  // 与 32001 分开：「预约不存在」与「评价不存在」的处置不同。
  REVIEW_NOT_FOUND = 34001,
  // 同一预约已有未删评价 → 409（唯一键 `uk_student_review_appointment_active`
  // 的业务侧表达；并发下 P2002 也兜到同一个码）。
  REVIEW_ALREADY_EXISTS = 34002,
  // 预约状态不是 `4 STUDENT_CONFIRMED` → 409。`4 → 6` 与「写评价」同一事务，
  // 并发的第二个请求在这里被挡下（`updateMany` 的 count = 0）。
  REVIEW_NOT_ALLOWED = 34003,

  // 双创成果 36000-36999（mentor-back，P3 成果域）。
  // `:achievementId` 不存在 / 已软删 / 不属于该导师 → 404。
  ACHIEVEMENT_NOT_FOUND = 36001,

  // 考核 35000-35999（mentor-back，P3 考核域）。
  // `:id` 不存在 / 已软删 → 404。
  ASSESSMENT_NOT_FOUND = 35001,
  // 状态机不允许该操作（合法迁移表之外）→ 409。
  ASSESSMENT_TRANSITION_INVALID = 35002,
  // 同一导师同一 `period` 已有考核 → 409（唯一键 `uk_assessment_mentor_period_active`
  // 的业务侧表达）。
  ASSESSMENT_PERIOD_TAKEN = 35003,
  // 考核申诉 `:appealId` 不存在 / 已软删 → 404。
  ASSESSMENT_APPEAL_NOT_FOUND = 35004,
  // 同一考核已有待处理申诉 → 409。
  ASSESSMENT_APPEAL_PENDING = 35005,
  // 考核状态不允许申诉（只有 `2 APPROVED` 可申诉）→ 409。
  ASSESSMENT_APPEAL_NOT_ALLOWED = 35006,

  // 归档 37000-37999（mentor-back，P4 归档域）。
  ARCHIVE_NOT_FOUND = 37001,
  ARCHIVE_ALREADY_EXISTS = 37002,
  // 导出结果超过 `export.max_rows`（默认 50000）→ 409，**不静默截断**（R62）。
  // 静默截断会让「导出名单」少人而无人察觉——报表系统最危险的失败模式。
  EXPORT_TOO_LARGE = 37004,

  // 消息 38000-38999（mentor-back，P5 消息 / 提醒域）。
  // 标记别人的消息 / 消息不存在 → 404，**藏存在性**。
  MESSAGE_NOT_FOUND = 38001,

  // 学生成果 39000-39999（mentor-back，P5 成果关联域）。
  STUDENT_ACHIEVEMENT_NOT_FOUND = 39001,
  // 已关联到导师的成果再次 link → 409。
  STUDENT_ACHIEVEMENT_ALREADY_LINKED = 39002,
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
  [39000, 39999],
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
  [ErrorCode.AUTH_SSO_UNAVAILABLE]:
    '统一认证暂不可用，请稍后重试',
  [ErrorCode.AUTH_SSO_CONFIG_INVALID]:
    '统一认证配置异常，请联系管理员',
  [ErrorCode.AUTH_SSO_RATE_LIMITED]:
    '统一认证请求过于频繁，请稍后重试',
  [ErrorCode.AUTH_SSO_RESPONSE_INVALID]:
    '统一认证返回异常，请稍后重试',
  [ErrorCode.AUTH_SSO_PASSWORD_MANAGED]:
    '统一认证账号请在统一认证平台修改密码',
  [ErrorCode.AUTH_SSO_PROVISION_FAILED]:
    '统一认证已通过，但本地账号创建失败，请联系管理员',
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
  [ErrorCode.MENTOR_SLOT_NOT_FOUND]: '可指导时段不存在',
  [ErrorCode.MENTOR_SLOT_UNAVAILABLE]: '可指导时段不可用',
  [ErrorCode.MENTOR_SLOT_OVERLAP]: '该时段与已有开放时段重叠',
  [ErrorCode.APPOINTMENT_NOT_FOUND]: '预约不存在',
  [ErrorCode.APPOINTMENT_FORBIDDEN]: '无权访问该预约',
  [ErrorCode.APPOINTMENT_TRANSITION_INVALID]: '当前状态不允许该操作',
  [ErrorCode.APPOINTMENT_SLOT_CONFLICT]: '该时段已被预约占用',
  [ErrorCode.APPOINTMENT_MATERIAL_NOT_FOUND]: '预约材料不存在',
  [ErrorCode.APPOINTMENT_MATERIAL_DUPLICATE]: '该材料已挂接',
  [ErrorCode.GUIDANCE_RECORD_NOT_FOUND]: '指导记录不存在',
  [ErrorCode.GUIDANCE_MATERIAL_NOT_FOUND]: '过程材料不存在',
  [ErrorCode.REVIEW_NOT_FOUND]: '该预约还没有评价',
  [ErrorCode.REVIEW_ALREADY_EXISTS]: '该预约已评价过',
  [ErrorCode.REVIEW_NOT_ALLOWED]: '当前状态不允许评价',
  [ErrorCode.ACHIEVEMENT_NOT_FOUND]: '双创成果不存在',
  [ErrorCode.ASSESSMENT_NOT_FOUND]: '考核不存在',
  [ErrorCode.ASSESSMENT_TRANSITION_INVALID]: '当前状态不允许该操作',
  [ErrorCode.ASSESSMENT_PERIOD_TAKEN]: '该导师本周期已有考核',
  [ErrorCode.ASSESSMENT_APPEAL_NOT_FOUND]: '考核申诉不存在',
  [ErrorCode.ASSESSMENT_APPEAL_PENDING]: '该考核已有待处理的申诉',
  [ErrorCode.ASSESSMENT_APPEAL_NOT_ALLOWED]: '当前考核状态不允许申诉',
  [ErrorCode.ARCHIVE_NOT_FOUND]: '归档条目不存在',
  [ErrorCode.ARCHIVE_ALREADY_EXISTS]: '该记录已归档',
  [ErrorCode.EXPORT_TOO_LARGE]: '导出结果超过上限，请缩小查询范围',
  [ErrorCode.MESSAGE_NOT_FOUND]: '消息不存在',
  [ErrorCode.STUDENT_ACHIEVEMENT_NOT_FOUND]: '学生成果不存在',
  [ErrorCode.STUDENT_ACHIEVEMENT_ALREADY_LINKED]: '该成果已关联导师',
};
