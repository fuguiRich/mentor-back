import { ApiProperty } from '@nestjs/swagger';

/**
 * 导师档案的 6 个状态计数。
 *
 * **六个键必须全在**（缺项补 0）：前端直接按这个对象画图，缺键会让图的轴忽长忽短。
 */
export class MentorStatusCountDto {
  @ApiProperty({ description: '草稿（0）', example: 0 })
  draft!: number;

  @ApiProperty({ description: '待审核（1）', example: 1 })
  pending!: number;

  @ApiProperty({ description: '已生效（2）', example: 12 })
  approved!: number;

  @ApiProperty({ description: '已驳回（3）', example: 0 })
  rejected!: number;

  @ApiProperty({ description: '已冻结（4）', example: 1 })
  frozen!: number;

  @ApiProperty({ description: '已移除（5）', example: 0 })
  removed!: number;
}

/** 一个指导方向的导师数 */
export class ResearchFieldCountDto {
  @ApiProperty({ description: '指导方向（自由文本）', example: '创新创业' })
  field!: string;

  @ApiProperty({ description: '该方向的生效导师数', example: 5 })
  count!: number;
}

/**
 * `GET /stats/mentors` 的响应（§4.1）。
 *
 * `total` / `internal` / `external` / `active` / `inactive` 都只算**生效档案**
 * （`status = 2`）；`byStatus` 是全部 6 个状态的全量分布——两组口径不同，
 * 前者回答「现在有多少能用的导师」，后者回答「档案都走到哪一步了」。
 *
 * `active` 的口径（R68）：生效档案在统计周期内有 **≥1 条 `status = 6` 的预约**。
 */
export class MentorStatsResponseDto {
  @ApiProperty({ description: '生效导师总数', example: 12 })
  total!: number;

  @ApiProperty({ description: '其中校内导师数', example: 9 })
  internal!: number;

  @ApiProperty({ description: '其中校外导师数', example: 3 })
  external!: number;

  @ApiProperty({ description: '活跃导师数（周期内完成过指导）', example: 8 })
  active!: number;

  @ApiProperty({
    description: '非活跃导师数（生效但周期内没完成过指导）',
    example: 4,
  })
  inactive!: number;

  @ApiProperty({
    description: '全部档案的状态分布（6 个键齐全）',
    type: MentorStatusCountDto,
  })
  byStatus!: MentorStatusCountDto;

  @ApiProperty({
    description: '指导方向分布，按 count 倒序、同数按 field 升序',
    type: [ResearchFieldCountDto],
  })
  byResearchField!: ResearchFieldCountDto[];
}
