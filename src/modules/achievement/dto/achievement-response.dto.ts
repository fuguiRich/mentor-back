import { ApiProperty } from '@nestjs/swagger';
import { ACHIEVEMENT_LEVELS, ACHIEVEMENT_TYPES } from './achievement.dto';

/**
 * 一条双创成果的响应形状（RES-03 / RES-04：显式映射，不序列化实体）。
 *
 * `awardedAt` 是**纯日期** `YYYY-MM-DD`（列是 `DATE`，不是时刻）：带上 `T00:00:00Z`
 * 会让前端在东八区显示成前一天——日期类的字段就该是日期。
 */
export class AchievementResponseDto {
  @ApiProperty({ description: '成果行 ID（BIGINT 对外字符串）', example: '1' })
  id!: string;

  @ApiProperty({
    description: '所属导师档案 ID（BIGINT 对外字符串）',
    example: '1',
  })
  mentorProfileId!: string;

  @ApiProperty({
    description: '成果类型：1 竞赛获奖 / 2 项目立项 / 3 其他',
    enum: ACHIEVEMENT_TYPES,
    example: 1,
  })
  type!: number;

  @ApiProperty({
    description: '成果名称',
    example: '中国国际大学生创新大赛省级银奖',
  })
  title!: string;

  @ApiProperty({
    description: '级别：1 国家级 / 2 省级 / 3 市级 / 4 校级 / 5 院级',
    enum: ACHIEVEMENT_LEVELS,
    example: 2,
  })
  level!: number;

  @ApiProperty({
    description: '获奖 / 立项日期，`YYYY-MM-DD`',
    example: '2026-09-15',
  })
  awardedAt!: string;

  @ApiProperty({
    description: '说明；未填时为 null',
    type: String,
    nullable: true,
    example: null,
  })
  description!: string | null;

  @ApiProperty({
    description: '佐证文件 ID（SysFile.id）；未挂时为 null',
    type: String,
    nullable: true,
    example: null,
  })
  proofFileId!: string | null;

  @ApiProperty({
    description: '登记时间（ISO 8601）',
    example: '2026-10-31T02:00:00.000Z',
  })
  createdAt!: string;
}

/** `GET /mentors/:mentorId/achievements` 的响应（RES-06） */
export class AchievementListResponseDto {
  @ApiProperty({ description: '当前页成果', type: [AchievementResponseDto] })
  list!: AchievementResponseDto[];

  @ApiProperty({ description: '总条数', example: 3 })
  total!: number;

  @ApiProperty({ description: '当前页码', example: 1 })
  page!: number;

  @ApiProperty({ description: '每页条数', example: 20 })
  pageSize!: number;
}
