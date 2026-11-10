import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DataScope } from '../../common/decorators/data-scope.decorator';
import { NoEnvelope } from '../../common/decorators/no-envelope.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ErrorCode } from '../../common/constants/error-code';
import type { RequestUser } from '../../common/context/request-context';
import { errExample } from '../../common/dto/err-example';
import { ArchiveService } from './archive.service';
import { ArchiveParamDto } from './dto/archive-param.dto';
import { ArchiveFileParamDto } from './dto/archive-file-param.dto';
import {
  ArchiveListResponseDto,
  ArchiveResponseDto,
} from './dto/archive-response.dto';
import { CreateArchiveDto } from './dto/create-archive.dto';
import { ListArchiveQueryDto } from './dto/list-archive-query.dto';
import { UpdateArchiveDto } from './dto/update-archive.dto';

/**
 * 归档（P4 Task 52 / §4.7）。
 *
 * 自动归档不在这里——两个审核通过点在各自的**审核事务**里落库（R66），
 * 本控制器只暴露手工归档与检索。
 */
@ApiTags('归档')
@Controller('archives')
export class ArchiveController {
  constructor(private readonly archiveService: ArchiveService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('archive:manage')
  @DataScope('all')
  @ApiOperation({
    summary: '手工归档一条材料（双创学院管理员）',
    description:
      '管理员把归档范围外的材料归档留存（§4.7）。请求体 ' +
      '`{ targetType, targetId, title, category, mentorId?, deptId?, summary? }`：' +
      '`targetType` 白名单 `MentorApplication / Assessment / GuidanceRecord / ' +
      'Achievement / Other`，`category` 白名单 `guidance-record / achievement / other`。' +
      '**`core` 不可由调用方设置**（带了一律 400 / 10001）：手工归档一律非核心，' +
      '保留期 = 归档日 + `archive.noncore_retention_days`（默认 1825 天）。' +
      '同一 `(targetType, targetId)` 已有未删归档 → **409 / 37002**。',
  })
  @ApiBody({ type: CreateArchiveDto })
  @ApiCreatedResponse({
    type: ArchiveResponseDto,
    description: '归档成功（201）',
  })
  @ApiBadRequestResponse({
    description:
      'targetType / category 不在白名单、core 出现、字段长度越界（400 / 10001）',
    schema: { example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败') },
  })
  @ApiConflictResponse({
    description: '该记录已归档（409 / 37002）',
    schema: {
      example: errExample(ErrorCode.ARCHIVE_ALREADY_EXISTS, '该记录已归档'),
    },
  })
  @ApiForbiddenResponse({
    description: '缺权限码 archive:manage（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async create(@Body() dto: CreateArchiveDto): Promise<ArchiveResponseDto> {
    return this.archiveService.create(dto);
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('archive:list')
  @DataScope('all')
  @ApiOperation({
    summary: '检索归档（§4.7）',
    description:
      '按导师 / 学院 / 分类 / 类型 / 归档时间段检索。' +
      '`from` / `to` 是**归档时间**的闭区间（`YYYY-MM-DD`），必须成对出现。' +
      '数据范围：双创学院看全校；学院管理员按归档时快照的 `deptId` 只看本院；' +
      '导师只看自己的。超出范围 → **403 / 10003**（不是空列表）。',
  })
  @ApiOkResponse({
    type: ArchiveListResponseDto,
    description: '检索结果（200）',
  })
  @ApiBadRequestResponse({
    description: 'from / to 只给一个、from 晚于 to、日期格式错（400 / 10001）',
    schema: { example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败') },
  })
  @ApiForbiddenResponse({
    description: '超出数据范围或学院管理员传 deptId（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async list(
    @Query() query: ListArchiveQueryDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<ArchiveListResponseDto> {
    return this.archiveService.list(query, caller);
  }

  /**
   * **路由顺序钉死**：`purge` 必须声明在 `:id` 三条路由之前（计划 Task 53）。
   * 本期 `purge` 只有 POST、与 PATCH/DELETE/GET 不冲突，但一旦以后给它加 GET，
   * `/archives/:id` 会先匹配到它并把 `purge` 当成 id。
   */
  @Post('purge')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('archive:manage')
  @DataScope('all')
  @ApiOperation({
    summary: '执行一次过期清理（双创学院管理员）',
    description:
      '清理 `core = 0` 且 `retentionUntil < 今天` 的归档条目（§6.5 / R65）。' +
      '「今天」按 `APP_TIMEZONE` 算；`retentionUntil = 今天` **不清理**（严格小于）。' +
      '**只软删 `archive_item` 行，绝不删 `SysFile`**——文件被多处引用。' +
      '幂等：连跑两次，第二次 `purged = 0`。',
  })
  @ApiOkResponse({
    description: '清理结果（200）',
    schema: { example: { code: 0, message: 'success', data: { purged: 2 } } },
  })
  @ApiForbiddenResponse({
    description: '缺权限码 archive:manage（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async purge(): Promise<{ purged: number }> {
    return this.archiveService.purge();
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('archive:list')
  @DataScope('all')
  @ApiOperation({
    summary: '归档详情',
    description:
      '不存在 / 已软删 → **404 / 37001**；超出数据范围 → **403 / 10003**。',
  })
  @ApiOkResponse({
    type: ArchiveResponseDto,
    description: '详情（200）',
  })
  @ApiNotFoundResponse({
    description: '归档条目不存在（404 / 37001）',
    schema: {
      example: errExample(ErrorCode.ARCHIVE_NOT_FOUND, '归档条目不存在'),
    },
  })
  @ApiForbiddenResponse({
    description: '超出数据范围（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async findById(
    @Param() params: ArchiveParamDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<ArchiveResponseDto> {
    return this.archiveService.findById(BigInt(params.id), caller);
  }

  @Get(':id/files/:fileId/preview')
  @NoEnvelope()
  @RequirePermission('archive:list')
  @DataScope('all')
  @ApiOperation({
    summary: '行内预览归档附件',
    description:
      '可见性与归档详情一致；`fileId` 必须是该归档的附件，否则 404 / 28101。' +
      '返回字节流，不是 JSON。',
  })
  @ApiProduces(
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/bmp',
    'application/pdf',
    'application/octet-stream',
  )
  @ApiOkResponse({ description: '返回文件字节流（不是 JSON）' })
  @ApiForbiddenResponse({
    description: '超出数据范围（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  @ApiNotFoundResponse({
    description: '归档 / 附件不存在（404 / 37001 或 28101）',
    schema: {
      example: errExample(ErrorCode.FILE_NOT_FOUND, '文件不存在'),
    },
  })
  async previewFile(
    @Param() params: ArchiveFileParamDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<StreamableFile> {
    return this.archiveService.previewFile(
      BigInt(params.id),
      BigInt(params.fileId),
      caller,
    );
  }

  @Get(':id/files/:fileId/download')
  @NoEnvelope()
  @RequirePermission('archive:list')
  @DataScope('all')
  @ApiOperation({
    summary: '下载归档附件',
    description: '可见性同预览；Content-Disposition: attachment。',
  })
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ description: '返回文件字节流（不是 JSON）' })
  @ApiForbiddenResponse({
    description: '超出数据范围（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  @ApiNotFoundResponse({
    description: '归档 / 附件不存在（404 / 37001 或 28101）',
    schema: {
      example: errExample(ErrorCode.FILE_NOT_FOUND, '文件不存在'),
    },
  })
  async downloadFile(
    @Param() params: ArchiveFileParamDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<StreamableFile> {
    return this.archiveService.downloadFile(
      BigInt(params.id),
      BigInt(params.fileId),
      caller,
    );
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('archive:manage')
  @DataScope('all')
  @ApiOperation({
    summary: '修改归档条目（双创学院管理员）',
    description:
      '只能改 `title` / `summary` / `retentionUntil`。`retentionUntil` 传 `null` ' +
      '取消自动清理；**核心材料（`core = 1`）不允许设置保留期**（400 / 10001）。' +
      '不存在 / 已软删 → **404 / 37001**。',
  })
  @ApiBody({ type: UpdateArchiveDto })
  @ApiOkResponse({
    type: ArchiveResponseDto,
    description: '修改成功（200）',
  })
  @ApiBadRequestResponse({
    description: '核心材料设置保留期、字段长度越界（400 / 10001）',
    schema: { example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败') },
  })
  @ApiNotFoundResponse({
    description: '归档条目不存在（404 / 37001）',
    schema: {
      example: errExample(ErrorCode.ARCHIVE_NOT_FOUND, '归档条目不存在'),
    },
  })
  @ApiForbiddenResponse({
    description: '缺权限码 archive:manage（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async update(
    @Param() params: ArchiveParamDto,
    @Body() dto: UpdateArchiveDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<ArchiveResponseDto> {
    return this.archiveService.update(BigInt(params.id), dto, caller);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('archive:manage')
  @DataScope('all')
  @ApiOperation({
    summary: '取消归档（软删，双创学院管理员）',
    description:
      '软删归档条目；同一 `(targetType, targetId)` 之后可以重新归档（DB-11 生成列唯一键）。' +
      '不存在 / 已软删 → **404 / 37001**。',
  })
  @ApiOkResponse({
    description: '取消归档（200）',
    schema: { example: { code: 0, message: 'success', data: { id: '3' } } },
  })
  @ApiNotFoundResponse({
    description: '归档条目不存在（404 / 37001）',
    schema: {
      example: errExample(ErrorCode.ARCHIVE_NOT_FOUND, '归档条目不存在'),
    },
  })
  @ApiForbiddenResponse({
    description: '缺权限码 archive:manage（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async remove(
    @Param() params: ArchiveParamDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<{ id: string }> {
    return this.archiveService.remove(BigInt(params.id), caller);
  }
}
