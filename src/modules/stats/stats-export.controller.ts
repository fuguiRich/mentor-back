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
import { StatsQueryDto } from './dto/stats-query.dto';
import { StatsService } from './stats.service';

/**
 * 导出（P4 Task 50）。全部走 `@NoEnvelope()` + `@Res()`：
 * CSV 不是 JSON，套统一外壳等于把文件写坏。
 *
 * **上限判定在写第一个字节之前**（R62）：`startCsv` 一旦落 BOM，响应头就发出去了，
 * 再抛 409 也改不成状态码，客户端只会拿到半份文件。所以服务层先取
 * `max_rows + 1` 行判断，超了直接抛 `EXPORT_TOO_LARGE`。
 */
@ApiTags('统计')
@Controller('stats')
export class StatsExportController {
  constructor(private readonly statsService: StatsService) {}

  @Get('mentors/export')
  @NoEnvelope()
  @RequirePermission('stats:mentor')
  @DataScope('all')
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: '导出导师名单（§4.1）',
    description:
      'CSV（UTF-8 + BOM）。表头：`工号,姓名,导师类型,所属学院,职称,指导方向,档案状态,入驻时间`。' +
      '超过 `export.max_rows`（默认 50000）→ **409 / 37004**，**不静默截断**。' +
      '文件名一律 ASCII。',
  })
  @ApiOkResponse({ description: 'CSV 文件' })
  async exportMentors(
    @Query() query: StatsQueryDto,
    @Res() response: Response,
    @CurrentUser() caller: RequestUser,
  ): Promise<void> {
    const payload = await this.statsService.exportMentors(query, caller);
    const write = startCsv(response, payload.filename, payload.header);
    write(payload.rows);
    response.end();
  }

  @Get('appointments/export')
  @NoEnvelope()
  @RequirePermission('stats:appointment')
  @DataScope('all')
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: '导出预约名单（§4.2）',
    description:
      'CSV（UTF-8 + BOM）。表头：`预约ID,学生学号,学生姓名,导师姓名,预约类型,状态,期望指导时间,发起时间`。' +
      '超过上限 → **409 / 37004**。',
  })
  @ApiOkResponse({ description: 'CSV 文件' })
  async exportAppointments(
    @Query() query: StatsQueryDto,
    @Res() response: Response,
    @CurrentUser() caller: RequestUser,
  ): Promise<void> {
    const payload = await this.statsService.exportAppointments(query, caller);
    const write = startCsv(response, payload.filename, payload.header);
    write(payload.rows);
    response.end();
  }

  @Get('guidance/export')
  @NoEnvelope()
  @RequirePermission('stats:guidance')
  @DataScope('all')
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: '导出指导工作统计表（§4.6 / §3.7）',
    description:
      'CSV（UTF-8 + BOM）。表头：`导师工号,导师姓名,所属学院,指导次数,指导时长(分钟),指导学生数,成果数`。' +
      '超过上限 → **409 / 37004**。',
  })
  @ApiOkResponse({ description: 'CSV 文件' })
  async exportGuidance(
    @Query() query: StatsQueryDto,
    @Res() response: Response,
    @CurrentUser() caller: RequestUser,
  ): Promise<void> {
    const payload = await this.statsService.exportGuidance(query, caller);
    const write = startCsv(response, payload.filename, payload.header);
    write(payload.rows);
    response.end();
  }

  @Get('assessments/export')
  @NoEnvelope()
  @RequirePermission('stats:assessment')
  @DataScope('all')
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: '导出考核结果表（§5.5 / §6.3）',
    description:
      'CSV（UTF-8 + BOM）。表头：`导师工号,导师姓名,所属学院,考核周期,初评等级,终评等级,综合得分,生效时间`。' +
      '`period` 必填。超过上限 → **409 / 37004**。',
  })
  @ApiOkResponse({ description: 'CSV 文件' })
  async exportAssessments(
    @Query() query: StatsQueryDto,
    @Res() response: Response,
    @CurrentUser() caller: RequestUser,
  ): Promise<void> {
    const payload = await this.statsService.exportAssessments(query, caller);
    const write = startCsv(response, payload.filename, payload.header);
    write(payload.rows);
    response.end();
  }
}
