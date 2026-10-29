import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  StreamableFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { ErrorCode } from '../../common/constants/error-code';
import { errExample } from '../../common/dto/err-example';
import { NoEnvelope } from '../../common/decorators/no-envelope.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { FILE_MAX_COUNT } from './file.constants';
import { UploadErrorInterceptor } from './upload-error.interceptor';
import {
  FileService,
  type RequestMeta,
  type UploadedFile,
} from './file.service';
import {
  FilePageResponseDto,
  FileParamDto,
  QueryFileDto,
  UploadOwnerDto,
} from './dto/file.dto';
import { FileResponseDto } from './dto/file-response.dto';

/**
 * 上传字段名是 `files`（可重复字段，1 到 FILE_MAX_COUNT 个）。
 * `UploadErrorInterceptor` 必须排在 `FilesInterceptor` **前面**——
 * multer 的错误是从它自己的 intercept() 抛出来的，内层拦截器看不见。
 */
@ApiTags('文件')
@Controller('files')
@UseInterceptors(UploadErrorInterceptor)
export class FileController {
  constructor(private readonly fileService: FileService) {}

  @Get()
  @RequirePermission('file:list')
  @ApiOperation({
    summary: '查询文件列表（分页）',
    description:
      '文件管理页的主视图，按上传时间倒序。列表里不带文件内容，' +
      '要用内容请走 /files/{id}/preview 或 /files/{id}/download。',
  })
  @ApiOkResponse({
    type: FilePageResponseDto,
    description: '查询成功；没有命中时 list 为 []、total 为 0',
  })
  async findPage(@Query() query: QueryFileDto): Promise<FilePageResponseDto> {
    return this.fileService.findPage(query);
  }

  @Post()
  @UseInterceptors(FilesInterceptor('files', FILE_MAX_COUNT))
  @RequirePermission('file:create')
  @ApiConsumes('multipart/form-data')
  // `@ApiBody` 不能省：Swagger 不会为 multipart 自动长出 requestBody，少了它
  // 这个接口在文档上就成了「无输入」——而它恰恰是最有输入的接口之一（表单字段
  // 全是攻击者可写的）。bootstrap.hasUserInput 判的就是 parameters / requestBody，
  // 少了这一条，「有输入 ⇒ 有 400」那条判据会把上传接口误判成无输入。
  @ApiBody({
    description:
      'multipart/form-data；表单字段名固定为 `files`，可重复。' +
      '可选归属字段 ownerType / ownerId 必须**成对**给出（或都不给）',
    schema: {
      type: 'object',
      required: ['files'],
      properties: {
        files: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          minItems: 1,
          maxItems: FILE_MAX_COUNT,
        },
        ownerType: { type: 'string', maxLength: 50 },
        ownerId: { type: 'string' },
      },
    },
  })
  @ApiOperation({
    summary: '上传文件（一次 1 到 10 个）',
    description:
      '表单字段名固定为 `files`，可重复。返回值与上传顺序一致。' +
      '\n\n**校验顺序：先看内容，再落盘。**允许的扩展名只有带可靠魔数的那几种' +
      '（png / jpg / gif / webp / bmp / pdf，见 file.constants.ts）；扩展名说了不算，' +
      '文件头说了才算。客户端声明的 Content-Type 一律不采用——它是一个随便写的字段，' +
      '用它做判定等于把开关交出去。' +
      '\n\n落盘名是 uuid + 扩展名，**原始文件名永不参与路径拼接**；' +
      '原始文件名只存在库里，下载时才回显。',
  })
  @ApiCreatedResponse({
    type: FileResponseDto,
    isArray: true,
    description: '上传成功，返回新建的文件记录',
  })
  @ApiBadRequestResponse({
    description:
      '文件为空 / 超过大小上限 / 类型不允许 / 内容与扩展名不符 / 数量超上限' +
      ' / 归属两字段只给了一个',
    schema: {
      example: errExample(
        ErrorCode.FILE_MAGIC_MISMATCH,
        '文件内容与扩展名不符',
      ),
    },
  })
  async upload(
    // multer 的结果是 `Express.Multer.File[]`，但 `@types/multer` 不在依赖里，
    // 服务层只认结构化类型 UploadedFile（file.service.ts:18-23）
    @UploadedFiles() files: UploadedFile[] | undefined,
    // multipart 的文本字段落在 req.body 上。走强类型 DTO——forbidNonWhitelisted
    // （bootstrap.ts）照常拦未知字段，不许写成 Record<string, unknown> 绕过它
    @Body() owner: UploadOwnerDto,
    @Req() req: Request,
  ): Promise<FileResponseDto[]> {
    return this.fileService.upload(files ?? [], toRequestMeta(req), owner);
  }

  @Get(':id/preview')
  @NoEnvelope()
  @RequirePermission('file:list')
  @ApiOperation({
    summary: '行内预览文件',
    description:
      'Content-Disposition: inline，浏览器直接渲染，不弹另存为。' +
      '返回的是文件字节流，**不是 JSON**——套进统一外壳会让文件直接坏掉。' +
      '白名单里没有 html / svg，所以预览面不会变成一个可执行页面。',
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
  @ApiNotFoundResponse({
    description: '文件不存在（含已软删除）',
    schema: {
      example: errExample(ErrorCode.FILE_NOT_FOUND, '文件不存在'),
    },
  })
  async preview(@Param() param: FileParamDto): Promise<StreamableFile> {
    return this.serve(BigInt(param.id), 'inline');
  }

  @Get(':id/download')
  @NoEnvelope()
  @RequirePermission('file:list')
  @ApiOperation({
    summary: '下载文件',
    description:
      'Content-Disposition: attachment，按**上传时的原始文件名**另存。' +
      "原始文件名里的非 ASCII 与引号走 RFC 5987（`filename*=UTF-8''…`），" +
      '同时给一个纯 ASCII 兜底文件名——一个中文名就能把没有 filename* 支持的客户端搞坏。',
  })
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ description: '返回文件字节流（不是 JSON）' })
  @ApiNotFoundResponse({
    description: '文件不存在（含已软删除）',
    schema: {
      example: errExample(ErrorCode.FILE_NOT_FOUND, '文件不存在'),
    },
  })
  async download(@Param() param: FileParamDto): Promise<StreamableFile> {
    return this.serve(
      BigInt(param.id),
      'attachment',
      'application/octet-stream',
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('file:delete')
  @ApiOperation({
    summary: '删除文件',
    description:
      '软删除。**磁盘上的文件不跟着删**——业务表里可能还引用着它，删了就是引用悬空；' +
      '磁盘清理属于归档策略，不在请求路径上做。',
  })
  @ApiOkResponse({ description: '删除成功（响应体为空）' })
  @ApiNotFoundResponse({
    description: '文件不存在（含已软删除）',
    schema: {
      example: errExample(ErrorCode.FILE_NOT_FOUND, '文件不存在'),
    },
  })
  async remove(
    @Param() param: FileParamDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.fileService.remove(BigInt(param.id), toRequestMeta(req));
  }

  /** R79：实现体已下沉到 `FileService.serve`，这里只剩一行委托，行为逐字不变 */
  private async serve(
    id: bigint,
    disposition: 'inline' | 'attachment',
    type?: string,
  ): Promise<StreamableFile> {
    return this.fileService.serve(id, disposition, type);
  }
}

/**
 * 只取 path（不含 query）与来源标识。`req.path` 长度受
 * sys_op_log.path 的 VARCHAR(200) 约束，超长截断——日志宁可丢尾巴，
 * 也不要因为一个超长 URL 把业务请求打成 500。
 */
function toRequestMeta(req: Request): RequestMeta {
  const userAgent = req.headers['user-agent'];
  return {
    method: req.method,
    path: req.path.slice(0, 200),
    ...(typeof req.ip === 'string' && req.ip !== '' ? { ip: req.ip } : {}),
    ...(typeof userAgent === 'string' ? { userAgent } : {}),
  };
}
