import { ApiProperty } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

/** `GET /assessments/:id/appeals` 的查询参数：只有分页 */
export class QueryAppealDto extends PaginationQueryDto {}

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
