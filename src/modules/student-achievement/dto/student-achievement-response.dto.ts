import { ApiProperty } from '@nestjs/swagger';

/** 一条学生成果的响应形状 */
export class StudentAchievementResponseDto {
  @ApiProperty({ description: '成果 ID（BIGINT 对外字符串）', example: '1' })
  id!: string;

  @ApiProperty({
    description: '学生（SyncPerson.id，BIGINT 对外字符串）',
    example: '5',
  })
  studentPersonId!: string;

  @ApiProperty({ description: '学生姓名', example: '陈一鸣' })
  studentName!: string;

  @ApiProperty({
    description: '关联导师（MentorProfile.id）；未关联为 null',
    type: String,
    nullable: true,
    example: '1',
  })
  mentorProfileId!: string | null;

  @ApiProperty({
    description: '关联时生成的导师成果 ID；未关联为 null',
    type: String,
    nullable: true,
    example: '9',
  })
  achievementId!: string | null;

  @ApiProperty({
    description: '学生所在学院快照（SysDept.id）',
    type: String,
    nullable: true,
    example: '2',
  })
  deptId!: string | null;

  @ApiProperty({
    description: '成果类型：1 竞赛获奖 / 2 项目立项 / 3 其他',
    enum: [1, 2, 3],
    example: 1,
  })
  type!: number;

  @ApiProperty({ description: '成果名称', example: '省级竞赛金奖' })
  title!: string;

  @ApiProperty({
    description: '级别：1 国家级 / 2 省级 / 3 市级 / 4 校级 / 5 院级',
    enum: [1, 2, 3, 4, 5],
    example: 2,
  })
  level!: number;

  @ApiProperty({
    description: '获奖 / 立项日期，`YYYY-MM-DD`',
    example: '2026-09-15',
  })
  awardedAt!: string;

  @ApiProperty({
    description: '佐证文件 ID；未挂时为 null',
    type: String,
    nullable: true,
    example: null,
  })
  proofFileId!: string | null;

  @ApiProperty({
    description: '关联时刻（ISO 8601）；未关联为 null',
    type: String,
    nullable: true,
    example: '2026-11-02T02:00:00.000Z',
  })
  linkedAt!: string | null;

  @ApiProperty({
    description: '创建时间（ISO 8601）',
    example: '2026-11-02T02:00:00.000Z',
  })
  createdAt!: string;
}

/** `GET /student-achievements` 的响应 */
export class StudentAchievementListResponseDto {
  @ApiProperty({
    description: '当前页学生成果',
    type: [StudentAchievementResponseDto],
  })
  list!: StudentAchievementResponseDto[];

  @ApiProperty({ description: '总条数', example: 3 })
  total!: number;

  @ApiProperty({ description: '当前页码', example: 1 })
  page!: number;

  @ApiProperty({ description: '每页条数', example: 20 })
  pageSize!: number;
}
