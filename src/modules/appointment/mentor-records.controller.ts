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
import { startCsv } from '../stats/export/csv.writer';
import { AppointmentService } from './appointment.service';
import { MentorRecordListResponseDto } from './dto/mentor-record-response.dto';
import { QueryMentorRecordDto } from './dto/query-mentor-record.dto';

/**
 * 导师本人的指导记录列表 / 导出（§3.6 / §3.7）。
 *
 * 与 `/me/records/export` 同构：没有 id 参数，服务层按身份链解析本人档案，
 * 所以不存在越权面。`@DataScope('self')` 是天花板。
 */
@ApiTags('指导记录')
@Controller('mentor')
export class MentorRecordsController {
  constructor(private readonly appointments: AppointmentService) {}

  @Get('records')
  @RequirePermission('appointment:list')
  @DataScope('self')
  @ApiOperation({
    summary: '我的指导记录列表',
    description:
      '按实际指导时间倒序。可按 `from` / `to`（ISO 8601）和预约类型 `type` 筛选。' +
      '只返回本人名下导师档案的记录；不是导师 → 403 / 32002。',
  })
  @ApiOkResponse({ type: MentorRecordListResponseDto })
  async list(
    @CurrentUser() caller: RequestUser,
    @Query() query: QueryMentorRecordDto,
  ): Promise<MentorRecordListResponseDto> {
    return this.appointments.listMentorRecords(caller, query);
  }

  @Get('records/export')
  @NoEnvelope()
  @RequirePermission('appointment:list')
  @DataScope('self')
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: '导出我的指导记录（CSV）',
    description:
      'CSV（UTF-8 + BOM）。表头：预约ID,学生,学号,预约类型,实际指导时间,指导方式,时长(分钟),核心指导内容,后续指导建议。' +
      '超过 `export.max_rows`（默认 50000）→ 409 / 37004。',
  })
  @ApiOkResponse({ description: 'CSV 文件' })
  async export(
    @Res() response: Response,
    @CurrentUser() caller: RequestUser,
    @Query() query: QueryMentorRecordDto,
  ): Promise<void> {
    const payload = await this.appointments.exportMentorRecords(caller, query);
    const write = startCsv(response, payload.filename, payload.header);
    write(payload.rows);
    response.end();
  }
}
