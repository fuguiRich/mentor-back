import { ApiProperty } from '@nestjs/swagger';

/** 等级分布（§6.3 的三个档：优秀 / 合格 / 不合格） */
export class GradeDistributionDto {
  @ApiProperty({ description: '优秀数', example: 4 })
  excellent!: number;

  @ApiProperty({ description: '合格数', example: 7 })
  qualified!: number;

  @ApiProperty({ description: '不合格数', example: 1 })
  unqualified!: number;
}

/** 按学院拆分的等级分布 */
export class DeptGradeDistributionDto extends GradeDistributionDto {
  @ApiProperty({
    description: '部门 ID（BIGINT 对外字符串）；导师没有部门投影时为 null',
    type: String,
    nullable: true,
    example: '2',
  })
  deptId!: string | null;

  @ApiProperty({
    description: '部门名；导师没有部门投影时为「未分配」',
    example: '计算机学院',
  })
  deptName!: string;

  @ApiProperty({ description: '该学院参与终评的考核总数', example: 5 })
  total!: number;
}

/** 按导师类型拆分的等级分布 */
export class MentorTypeGradeDistributionDto extends GradeDistributionDto {
  @ApiProperty({
    description: '导师类型：`internal` 校内 / `external` 校外',
    example: 'internal',
  })
  mentorType!: 'internal' | 'external';

  @ApiProperty({ description: '该类型参与终评的考核总数', example: 9 })
  total!: number;
}

/** 按指导方向拆分的等级分布 */
export class FieldGradeDistributionDto extends GradeDistributionDto {
  @ApiProperty({ description: '指导方向', example: '创新创业' })
  field!: string;

  @ApiProperty({ description: '该方向参与终评的考核总数', example: 6 })
  total!: number;
}

/**
 * `GET /stats/assessments` 的响应（§6.3 / §6.8）。
 *
 * **只统计 `status = 2 APPROVED`**（已生效）的考核：未终评的没有等级，
 * 把 `status = 1` 的行算进来会让「不合格率」随时间自己变化。
 *
 * 三个分布的分母口径不同：`byDept` 各行的 `total` 之和、`byMentorType` 各行的
 * `total` 之和都**等于** `total`；`byResearchField` 的 `total` 之和会**大于**
 * `total`——一个导师多个方向时在每个方向各计一次。
 */
export class AssessmentStatsResponseDto {
  @ApiProperty({ description: '本期已生效的考核数', example: 12 })
  total!: number;

  @ApiProperty({ description: '等级总分布', type: GradeDistributionDto })
  byGrade!: GradeDistributionDto;

  @ApiProperty({ description: '按学院拆分', type: [DeptGradeDistributionDto] })
  byDept!: DeptGradeDistributionDto[];

  @ApiProperty({
    description: '按导师类型拆分',
    type: [MentorTypeGradeDistributionDto],
  })
  byMentorType!: MentorTypeGradeDistributionDto[];

  @ApiProperty({
    description: '按指导方向拆分',
    type: [FieldGradeDistributionDto],
  })
  byResearchField!: FieldGradeDistributionDto[];
}
