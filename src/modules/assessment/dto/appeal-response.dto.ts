import { ApiProperty } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { AssessmentUserRefDto } from './assessment-response.dto';

/** `GET /assessments/:id/appeals` 的查询参数：只有分页 */
export class QueryAppealDto extends PaginationQueryDto {}

/** 申诉关联的考核摘要 */
export class AppealAssessmentRefDto {
  @ApiProperty({ description: '考核 ID', example: '1' })
  id!: string;

  @ApiProperty({ description: '考核周期', example: '2026-1' })
  period!: string;

  @ApiProperty({ description: '导师档案 ID', example: '1' })
  mentorProfileId!: string;

  @ApiProperty({ description: '导师姓名', example: '张明远' })
  mentorName!: string;

  @ApiProperty({
    description: '考核状态：2 已生效 / 4 申诉中 / 5 申诉已受理 / 6 申诉已驳回',
    example: 4,
  })
  status!: number;
}

/**
 * 一条考核申诉的响应形状（RES-03 / RES-04）。
 *
 * 状态机：`0 PENDING → 1 ACCEPTED | 2 REJECTED`，**终态 1 / 2**。
 */
export class AppealResponseDto {
  @ApiProperty({ description: '申诉行 ID（BIGINT 对外字符串）', example: '1' })
  id!: string;

  @ApiProperty({
    description: '所属考核 ID（BIGINT 对外字符串）',
    example: '1',
  })
  assessmentId!: string;

  @ApiProperty({
    description: '所属考核摘要（周期 / 导师 / 当前状态）',
    type: AppealAssessmentRefDto,
  })
  assessment!: AppealAssessmentRefDto;

  @ApiProperty({
    description: '申诉说明',
    example: '初评材料遗漏了省级奖项，请复核。',
  })
  reason!: string;

  @ApiProperty({
    description: '状态：0 待处理 / 1 已受理 / 2 已驳回',
    example: 0,
  })
  status!: number;

  @ApiProperty({
    description: '处理意见；未处理时为 null',
    type: String,
    nullable: true,
    example: null,
  })
  reply!: string | null;

  @ApiProperty({
    description: '处理时间（ISO 8601）；未处理时为 null',
    type: String,
    nullable: true,
    example: null,
  })
  handledAt!: string | null;

  @ApiProperty({
    type: AssessmentUserRefDto,
    description: '提交申诉的导师用户；系统数据缺失时为 null',
    nullable: true,
  })
  submittedBy!: AssessmentUserRefDto | null;

  @ApiProperty({
    type: AssessmentUserRefDto,
    description: '处理人；未处理时为 null',
    nullable: true,
  })
  handledBy!: AssessmentUserRefDto | null;

  @ApiProperty({
    description: '提交时间（ISO 8601）',
    example: '2026-11-01T02:00:00.000Z',
  })
  createdAt!: string;
}

/** `GET /assessments/:id/appeals` 的响应（RES-06） */
export class AppealListResponseDto {
  @ApiProperty({ description: '当前页申诉', type: [AppealResponseDto] })
  list!: AppealResponseDto[];

  @ApiProperty({ description: '总条数', example: 1 })
  total!: number;

  @ApiProperty({ description: '当前页码', example: 1 })
  page!: number;

  @ApiProperty({ description: '每页条数', example: 20 })
  pageSize!: number;
}
