import { ApiProperty } from '@nestjs/swagger';
import { ReviewRecord } from './review.dto';

/**
 * 入驻 / 信息修改申请的读写形状（Task 13 起，Task 14 / 15 / 18 / 19 沿用）。
 *
 * 两条状态机各走各的、别混（brief §0.4）：
 * - `MentorApplication.status`（0-7）是**申请**的流程态；
 * - `MentorProfile.status`（0-5）是**档案**的入驻态（在 mentor 模块的 dto 里）。
 */

/** `MentorApplication.type` 的 2 个值 */
export const MENTOR_APPLICATION_TYPE = {
  ONBOARD: 1,
  PROFILE_CHANGE: 2,
} as const;

export type MentorApplicationType =
  (typeof MENTOR_APPLICATION_TYPE)[keyof typeof MENTOR_APPLICATION_TYPE];

/**
 * `MentorApplication.status` 的 8 个值（申请的流程态）。
 * `1 SUBMITTED` 是状态机上的**一条边**（1 → 2 系统自动推进），不是可停留的状态，
 * 对外可见的提交终态恒为 `2 COLLEGE_REVIEWING`（brief §0.4）。
 */
export const MENTOR_APPLICATION_STATUS = {
  DRAFT: 0,
  SUBMITTED: 1,
  COLLEGE_REVIEWING: 2,
  COLLEGE_REJECTED: 3,
  SC_REVIEWING: 4,
  SC_REJECTED: 5,
  APPROVED: 6,
  WITHDRAWN: 7,
} as const;

export type MentorApplicationStatus =
  (typeof MENTOR_APPLICATION_STATUS)[keyof typeof MENTOR_APPLICATION_STATUS];

/**
 * `MentorProfileDraft` —— 提交即快照的形状（brief §3，Task 15 / 18 / 19 按此取）。
 *
 * = **当前 `MentorProfile` 行的可填报字段 + 推导出来的 `mentorType`**。
 * 不含 `id` / `personId` / `status` / 审计列。落 `MentorApplication.snapshot`
 * （JSON 列），**落库后永不改写**——后续 `PUT /mentor/profile` 改档案不影响
 * 已提交申请的 `snapshot`。
 *
 * `mentorType` **不落列**：由 `SyncPerson.personType` 推导
 * （internalMentor→internal，externalMentor→external，`deriveMentorType` 的口径）。
 * `affiliateOrg` / `socialRoles` 校内导师恒 `null`（R49，档案行里就已是 NULL）。
 *
 * 落成 `class` 而不是 brief 草图里的 `type`：DTO-03（DTO 必须是 class，禁止
 * interface / type）——而且只有 class 能带 `@ApiProperty`，`snapshot` 的
 * OpenAPI schema 才生成得出结构（DOC-06）。字段名与类型与 brief §3 逐字一致，
 * Task 15 / 18 / 19 拿它当类型标注对象字面量照样可用（无方法、无私有成员）。
 */
export class MentorProfileDraft {
  @ApiProperty({
    description:
      '导师类型：internal 校内 / external 校外。由 SyncPerson.personType 推导，不落列',
    enum: ['internal', 'external'],
    example: 'internal',
  })
  mentorType!: 'internal' | 'external';

  @ApiProperty({
    description:
      '指导方向，自由文本数组（Ruling #13：不做字典）。每项 ≤ 30 字符、≤ 5 项',
    type: [String],
    example: ['创新创业', '人工智能'],
  })
  researchFields!: string[];

  @ApiProperty({
    type: String,
    description: '个人简介，≤ 2000 字符（R48）',
    example: '长期从事……',
    nullable: true,
  })
  summary!: string | null;

  @ApiProperty({
    type: String,
    description: '研究成果，≤ 2000 字符（R48）',
    example: '主持省部级课题 2 项……',
    nullable: true,
  })
  achievements!: string | null;

  @ApiProperty({
    type: String,
    description: '指导经验，≤ 2000 字符（R48）',
    example: '累计指导学生 30 人……',
    nullable: true,
  })
  guidanceExperience!: string | null;

  @ApiProperty({
    type: String,
    description:
      '合作单位，≤ 100 字符。**仅校外（mentorType=external）非空**；校内恒 null（R49）',
    example: '某某研究院',
    nullable: true,
  })
  affiliateOrg!: string | null;

  @ApiProperty({
    type: String,
    description:
      '社会任职，≤ 100 字符。**仅校外（mentorType=external）非空**；校内恒 null（R49）',
    example: '某某学会理事',
    nullable: true,
  })
  socialRoles!: string | null;

  @ApiProperty({
    type: String,
    description:
      '职称 / 资质，自由文本，≤ 100 字符（R28）。**内校 / 外校都填**（与 affiliateOrg / ' +
      'socialRoles 不同，不置 null）。**旧快照（Task 20c 之前落库的）没有这个键**，' +
      '读取时归一为 null',
    example: '教授',
    nullable: true,
  })
  professionalTitle!: string | null;
}

/**
 * `MentorApplication` 的响应 DTO（计划 Interfaces 的形状，字段名不得改）。
 *
 * `collegeReview` / `scReview` 自 Task 14 起定型为 `ReviewRecord | null`
 * （形状见 dto/review.dto.ts，Task 15 / 18 / 19 按此取）；未审核的那一跳为 null。
 */
export class MentorApplicationResponseDto {
  @ApiProperty({ description: '申请行 ID（BIGINT 对外字符串）', example: '1' })
  id!: string;

  @ApiProperty({
    description:
      '申请类型：1 ONBOARD 入驻 | 2 PROFILE_CHANGE 信息修改（本任务恒 1）',
    enum: [1, 2],
    example: 1,
  })
  type!: MentorApplicationType;

  @ApiProperty({
    description: '申请人（SyncPerson.id，BIGINT 对外字符串）。本人，不来自入参',
    example: '1',
  })
  applicantId!: string;

  @ApiProperty({
    type: MentorProfileDraft,
    description:
      '提交当时的填报内容（MentorProfileDraft 形状）。**提交即快照**：落库后永不改写，' +
      '后续 PUT /mentor/profile 改档案不影响它',
  })
  snapshot!: MentorProfileDraft;

  @ApiProperty({
    description:
      '申请状态：0 DRAFT | 1 SUBMITTED | 2 COLLEGE_REVIEWING | 3 COLLEGE_REJECTED | ' +
      '4 SC_REVIEWING | 5 SC_REJECTED | 6 APPROVED | 7 WITHDRAWN。' +
      '本任务提交后恒 2（1 → 2 是系统自动推进的边，1 不单独暴露）',
    enum: [0, 1, 2, 3, 4, 5, 6, 7],
    example: 2,
  })
  status!: MentorApplicationStatus;

  @ApiProperty({
    type: ReviewRecord,
    description:
      '二级学院那一跳的审核记录（ReviewRecord 形状）；未审核为 null。' +
      '5 → 4 重审通过时**覆盖**这一跳（留最近一次的）',
    example: null,
    nullable: true,
  })
  collegeReview!: ReviewRecord | null;

  @ApiProperty({
    type: ReviewRecord,
    description: '双创学院那一跳的审核记录（ReviewRecord 形状）；未审核为 null',
    example: null,
    nullable: true,
  })
  scReview!: ReviewRecord | null;

  @ApiProperty({
    type: String,
    description: '提交时刻（ISO 8601 UTC）',
    example: '2026-10-28T03:00:00.000Z',
  })
  submittedAt!: string;
}
