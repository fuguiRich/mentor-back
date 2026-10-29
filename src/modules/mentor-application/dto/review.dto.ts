import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * 两级审核的入参与审核记录形状（Task 14，brief §3 / §4）。
 *
 * - `CollegeReviewDto` / `ScReviewDto`：`college-review` / `sc-review` 两个
 *   动作的请求体。`withdraw` 是**空 DTO**（`WithdrawApplicationDto`），
 *   出现任何字段 → 400 / 10001（全局 forbidNonWhitelisted）。
 * - `ReviewRecord`：落 `MentorApplication.collegeReview` / `scReview` 两个 JSON
 *   列的形状，**本任务定死**，Task 15 / 18 / 19 按此取。`collegeReview` 存
 *   二级学院那一跳，`scReview` 存双创那一跳；`5 → 4` 重审**覆盖** `collegeReview`
 *   （留最近一次的），不是追加数组。
 */

/**
 * 审核记录（brief §4）：
 * `{ reviewerId; reviewerName; decision; comment; at }`，字段名逐字。
 *
 * 落成 `class` 而不是 `type`（DTO-03）——`collegeReview` / `scReview` 的
 * OpenAPI schema 靠它生成出结构（DOC-06），响应 DTO 直接引用它。
 * 无方法、无私有成员，业务代码拿它当类型标注对象字面量照样可用。
 */
export class ReviewRecord {
  @ApiProperty({
    description: '审核人（SysUser.id，BIGINT 对外字符串）',
    example: '3',
  })
  reviewerId!: string;

  @ApiProperty({
    description:
      '审核人姓名快照（当时的 realName，不是外键——改名后历史记录不动）',
    example: '张三',
  })
  reviewerName!: string;

  @ApiProperty({
    description: '决定：approve 通过 / reject 不通过',
    enum: ['approve', 'reject'],
    example: 'approve',
  })
  decision!: 'approve' | 'reject';

  @ApiProperty({
    description:
      '审核意见，1-500 字符。**approve 也必填**（裁定 R57，两分支同形）',
    example: '材料齐全，同意',
  })
  comment!: string;

  @ApiProperty({
    type: String,
    description: '审核时刻（ISO 8601 UTC）',
    example: '2026-10-29T03:00:00.000Z',
  })
  at!: string;
}

/** 两个 decision 的合法取值（@IsIn 与 OpenAPI enum 共用一份） */
export const REVIEW_DECISIONS = ['approve', 'reject'] as const;

export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/**
 * `POST /mentor-applications/:id/college-review` 的请求体。
 * 有效出发态 2 / 5（R54 重审）；approve → 4、reject → 3。
 */
export class CollegeReviewDto {
  @ApiProperty({
    description:
      '审核决定：approve 通过（送双创）/ reject 不通过（退回申请人）',
    enum: [...REVIEW_DECISIONS],
    example: 'approve',
  })
  @IsIn([...REVIEW_DECISIONS], {
    message: 'decision 只能是 approve 或 reject',
  })
  decision!: ReviewDecision;

  @ApiProperty({
    description:
      '审核意见，1-500 字符。**两个决定都必填**（R57）——「通过」也留一句意见，' +
      '两分支同形比「一个必填一个选填」更难写错',
    minLength: 1,
    maxLength: 500,
    example: '材料齐全，同意',
  })
  @IsString({ message: 'comment 必须是字符串' })
  @IsNotEmpty({ message: 'comment 不能为空（approve 也必填）' })
  @MaxLength(500, { message: 'comment 长度不能超过 500 个字符' })
  comment!: string;
}

/**
 * `POST /mentor-applications/:id/sc-review` 的请求体。
 * 有效出发态 4；approve → 6、reject → 5。
 *
 * **与 CollegeReviewDto 同形**（R57）：分两个名字是为了路由语义与
 * Task 15 / 18 的引用点各自稳定，不是形状有差别——继承表达「同形」，
 * 免得两份字段表日后悄悄分叉。
 */
export class ScReviewDto extends CollegeReviewDto {}

/**
 * `POST /mentor-applications/:id/withdraw` 的请求体——**空 DTO**。
 * 撤回没有入参可收（「撤自己的」靠身份链判定），请求体出现任何字段
 * 一律 400 / 10001（同 SubmitOnboardDto 的空白名单理由）。
 */
export class WithdrawApplicationDto {}
