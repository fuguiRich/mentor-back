import { Controller, Get, Query, Res } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DataScope } from '../../common/decorators/data-scope.decorator';
import { NoEnvelope } from '../../common/decorators/no-envelope.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/context/request-context';
import { startCsv } from './export/csv.writer';
import {
  MeRecordListResponseDto,
  MeReviewListResponseDto,
  QueryMyRecordDto,
} from './dto/me-record.dto';
import { StatsService } from './stats.service';

/**
 * 学生个人指导档案导出（§2.6）。
 *
 * 挂在 `/me` 下而不是 `/stats`：它导出的是**调用者自己的**记录，
 * 没有「别人的」这个维度。数据范围 `@DataScope('self')` 是天花板，
 * 服务层按身份链解析出本人的 `SyncPerson.id` 后按它过滤——
 * 所以这里**没有**任何 id 参数可传，也就不存在越权面。
 */
@ApiTags('统计')
@Controller('me')
export class MeRecordsController {
  constructor(private readonly statsService: StatsService) {}

  @Get('records')
  @RequirePermission('stats:guidance')
  @DataScope('self')
  @ApiOperation({
    summary: '我的指导记录列表（学生）',
    description:
      '只返回调用者本人 `status = 6 COMPLETED` 的预约，附带实际指导时间 / 时长' +
      '与我的评价（未评价的字段为 null）。可按 `from` / `to`（ISO 8601）与 ' +
      '`type` 筛选；`from` / `to` 按实际指导时间过滤。',
  })
  @ApiOkResponse({ type: MeRecordListResponseDto })
  async listMyRecords(
    @CurrentUser() caller: RequestUser,
    @Query() query: QueryMyRecordDto,
  ): Promise<MeRecordListResponseDto> {
    return this.statsService.listStudentRecords(caller, query);
  }

  @Get('reviews')
  @RequirePermission('stats:guidance')
  @DataScope('self')
  @ApiOperation({
    summary: '我的评价列表（学生）',
    description:
      '只返回调用者本人写过的评价，按评价时间倒序。可按 `from` / `to`（ISO 8601）' +
      '与 `type` 筛选；`from` / `to` 按评价时间过滤。',
  })
  @ApiOkResponse({ type: MeReviewListResponseDto })
  async listMyReviews(
    @CurrentUser() caller: RequestUser,
    @Query() query: QueryMyRecordDto,
  ): Promise<MeReviewListResponseDto> {
    return this.statsService.listStudentReviews(caller, query);
  }

  @Get('records/export')
  @NoEnvelope()
  @RequirePermission('stats:guidance')
  @DataScope('self')
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: '导出我的指导档案（学生）',
    description:
      'CSV（UTF-8 + BOM）。表头：`预约ID,导师姓名,预约类型,指导主题,实际指导时间,指导时长(分钟),我的评分,我的评价`。' +
      '只含调用者本人 `status = 6 COMPLETED` 的预约。' +
      '超过 `export.max_rows`（默认 50000）→ **409 / 37004**，不静默截断。',
  })
  @ApiOkResponse({ description: 'CSV 文件' })
  async exportMyRecords(
    @Res() response: Response,
    @CurrentUser() caller: RequestUser,
  ): Promise<void> {
    const payload = await this.statsService.exportStudentRecords(caller);
    const write = startCsv(response, payload.filename, payload.header);
    write(payload.rows);
    response.end();
  }
}
