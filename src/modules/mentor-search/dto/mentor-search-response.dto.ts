import { ApiProperty } from '@nestjs/swagger';

/**
 * 导师类型（响应 / 筛选共用的两个字面量）。
 *
 * **不落列**：由 `SyncPerson.personType` 推导（internalMentor → internal，
 * externalMentor → external），推导本身经 `MentorMapperProvider` 复用
 * （MentorModule 的对外映射面，LAYER-06），本文件只声明词表。
 */
export const MENTOR_SEARCH_TYPES = ['internal', 'external'] as const;

export type MentorSearchType = (typeof MENTOR_SEARCH_TYPES)[number];

/**
 * `GET /mentors` 的列表项（Task 22）。
 *
 * 字段与计划 §Task 22「列表项」逐字一致：`id` / `name` / `mentorType` /
 * `deptName` / `professionalTitle` / `researchFields` / `summary`。
 *
 * **R27**：§2.1 的「学号 / 姓名 / 学院 / 专业 / 行政班级」是**学生**字段，
 * 不属于导师检索页——这里一个都不出现（`name` 是导师姓名，不是学生姓名）。
 */
export class MentorSearchItemResponseDto {
  @ApiProperty({
    description: '导师专业档案 ID（BIGINT 对外字符串）',
    example: '1',
  })
  id!: string;

  @ApiProperty({
    description: '导师姓名（SyncPerson.realName）',
    example: '张明远',
  })
  name!: string;

  @ApiProperty({
    description:
      '导师类型：internal 校内 / external 校外。由 SyncPerson.personType 推导，不落列',
    enum: ['internal', 'external'],
    example: 'internal',
  })
  mentorType!: MentorSearchType;

  @ApiProperty({
    description: '所属单位（SyncOrgUnit.name，经 SyncPerson.orgUnit 投影）',
    example: '计算机学院',
  })
  deptName!: string;

  @ApiProperty({
    type: String,
    description: '职称 / 资质（R28，自由文本）；未填为 null',
    example: '教授',
    nullable: true,
  })
  professionalTitle!: string | null;

  @ApiProperty({
    type: [String],
    description: '指导方向（JSON 数组，自由文本，≤ 5 项）',
    example: ['软件工程', '人工智能'],
  })
  researchFields!: string[];

  @ApiProperty({
    type: String,
    description: '个人简介；未填为 null',
    example: '长期从事软件工程与人工智能方向的教学与科研工作。',
    nullable: true,
  })
  summary!: string | null;
}

/**
 * 导师的可指导时段（只读投影）。学生端发起预约需要 `slotId`，详情里直接带出来，
 * 省掉一次 `GET /mentor/slots`（那个接口是导师管理自己的时段用的，学生无权）。
 */
export class MentorTimeSlotDto {
  @ApiProperty({ description: '时段 ID（BIGINT 对外字符串）', example: '12' })
  id!: string;

  @ApiProperty({ description: '导师专业档案 ID', example: '1' })
  mentorProfileId!: string;

  @ApiProperty({
    description: '星期：1 周一 … 7 周日',
    example: 3,
    enum: [1, 2, 3, 4, 5, 6, 7],
  })
  weekday!: number;

  @ApiProperty({ description: '开始时间 HH:mm', example: '09:00' })
  startTime!: string;

  @ApiProperty({ description: '结束时间 HH:mm', example: '11:00' })
  endTime!: string;

  @ApiProperty({
    description: '状态：0 关闭 / 1 开放。详情只返回开放的时段，恒为 1',
    example: 1,
    enum: [0, 1],
  })
  status!: number;
}

/**
 * `GET /mentors/:id` 的详情：列表项的全部字段 + §2.1「查看内容」与 §3.1
 * 的联系电话。**同样不含任何学生字段**（R27）。
 */
export class MentorSearchDetailResponseDto extends MentorSearchItemResponseDto {
  @ApiProperty({
    type: String,
    description: '研究成果（Prisma 列 research_achievements）；未填为 null',
    example: '主持省部级项目 2 项，发表论文 10 余篇。',
    nullable: true,
  })
  researchAchievements!: string | null;

  @ApiProperty({
    type: String,
    description: '指导经历 / 经验；未填为 null',
    example: '指导研究生 12 名。',
    nullable: true,
  })
  guidanceExperience!: string | null;

  @ApiProperty({
    type: String,
    description: '合作单位（仅校外导师非空，R49）；未填为 null',
    example: '某某研究院',
    nullable: true,
  })
  affiliateOrg!: string | null;

  @ApiProperty({
    type: String,
    description: '社会任职（仅校外导师非空，R49）；未填为 null',
    example: '某某学会理事',
    nullable: true,
  })
  socialRoles!: string | null;

  @ApiProperty({
    type: String,
    description: '联系电话（SyncPerson.mobile）；未填为 null',
    example: '13800000000',
    nullable: true,
  })
  mobile!: string | null;

  @ApiProperty({
    type: [MentorTimeSlotDto],
    description:
      '当前开放（status = 1）且未软删的可指导时段，按星期 / 开始时间升序。' +
      '发起预约时从这里取 `id` 作为 `slotId`。',
  })
  timeSlots!: MentorTimeSlotDto[];
}
