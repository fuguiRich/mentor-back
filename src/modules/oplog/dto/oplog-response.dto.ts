import { ApiProperty } from '@nestjs/swagger';

export class OpLogResponseDto {
  @ApiProperty({ description: '操作日志 ID', example: '1' })
  id!: string;

  @ApiProperty({ description: '业务模块', example: 'role', maxLength: 50 })
  module!: string;

  @ApiProperty({ description: '动作', example: 'update', maxLength: 50 })
  action!: string;

  @ApiProperty({
    type: String,
    description: '目标对象类型',
    example: 'SysRole',
    nullable: true,
  })
  targetType!: string | null;

  @ApiProperty({
    type: String,
    description: '目标对象标识（字符串化，避免前端 BIGINT 精度丢失）',
    example: '12',
    nullable: true,
  })
  targetId!: string | null;

  @ApiProperty({
    description:
      '操作人用户标识。与 createdBy 同一列——「谁做的」只有一个来源，不另设 operator_id',
    example: '3',
  })
  operatorId!: string;

  @ApiProperty({
    description:
      '操作人姓名**快照**：改名 / 销号后历史日志仍显示当时的名字，' +
      '列表页不必为了显示去 join sys_user',
    example: '张三',
  })
  operatorName!: string;

  @ApiProperty({ description: 'HTTP 方法', example: 'PUT', maxLength: 10 })
  method!: string;

  @ApiProperty({
    description: '请求路径（不含 query）',
    example: '/roles/12',
    maxLength: 200,
  })
  path!: string;

  @ApiProperty({
    type: String,
    description: '来源 IP（IPv4 或 IPv6，最长 45 字符）',
    example: '10.1.2.3',
    nullable: true,
  })
  ip!: string | null;

  @ApiProperty({
    type: String,
    description: 'User-Agent 截断到 255 字符',
    example: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) …',
    nullable: true,
  })
  userAgent!: string | null;

  @ApiProperty({
    description: '执行结果：1 成功 / 0 失败',
    example: 1,
    enum: [1, 0],
  })
  status!: number;

  @ApiProperty({
    type: Number,
    description: '失败时的业务错误码（error-code.ts 的枚举值）',
    example: 22101,
    nullable: true,
  })
  errorCode!: number | null;

  @ApiProperty({
    type: String,
    description: '失败时的错误信息',
    example: '角色不存在',
    nullable: true,
  })
  errorMsg!: string | null;

  // `additionalProperties: true` 是**显式的自由形态声明**，不是漏写结构。
  // 快照的形状由写入方决定，日志层无从约定；OpenAPI 表达「任意 JSON 对象」
  // 就是这一句。契约测试把它算作「有结构」，与退化出来的空 `type: object`
  // （`X | null` 忘写 type）区分开——后者既没有 properties 也没有 additionalProperties。
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: '变更前快照（更新 / 删除时才有）。形状由写入方决定',
    example: { name: '只读角色', dataScope: 'self' },
    nullable: true,
  })
  before!: unknown;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: '变更后快照（新建 / 更新时才有）。形状由写入方决定',
    example: { name: '只读角色', dataScope: 'dept' },
    nullable: true,
  })
  after!: unknown;

  @ApiProperty({ description: '处理耗时（毫秒）', example: 12 })
  durationMs!: number;

  @ApiProperty({
    description: '发生时间（UTC，ISO 8601）',
    example: '2026-10-20T03:00:00.000Z',
  })
  createdAt!: string;
}
