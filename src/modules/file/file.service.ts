import { HttpStatus, Injectable, StreamableFile } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { AppConfig } from '../../config/configuration';
import { ErrorCode } from '../../common/constants/error-code';
import { BusinessException } from '../../common/errors/business.exception';
import { OpLogService } from '../oplog/oplog.service';
import { contentDisposition } from './content-disposition';
import {
  DEFAULT_FILE_ROOT,
  FILE_MAX_COUNT,
  MAGIC_HEAD_BYTES,
  findTypeByExt,
} from './file.constants';
import { FileStorage } from './file.storage';
import { FileRepository } from './file.repository';
import { toFileResponse } from './file.mapper';
import type {
  FilePageResponseDto,
  QueryFileDto,
  UploadOwnerDto,
} from './dto/file.dto';
import type { FileResponseDto } from './dto/file-response.dto';

/**
 * multer 的 `Express.Multer.File` 有十几个字段，这里只声明用到的四个——
 * 结构化类型让服务不依赖 `@types/multer`，测试也能用一个纯对象喂进来。
 */
export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** 请求侧的 HTTP 细节。上下文里没有它们，由控制器从 `@Req()` 取出来传 */
export interface RequestMeta {
  method: string;
  path: string;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class FileService {
  private readonly storage: FileStorage;
  private readonly maxBytes: number;

  constructor(
    private readonly repository: FileRepository,
    private readonly opLog: OpLogService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.storage = new FileStorage(
      config.get('file.root', { infer: true }) ?? DEFAULT_FILE_ROOT,
    );
    this.maxBytes =
      config.get('file.maxBytes', { infer: true }) ?? 10 * 1024 * 1024;
  }

  async findPage(query: QueryFileDto): Promise<FilePageResponseDto> {
    const { rows, total } = await this.repository.findMany({
      ...(query.originName === undefined
        ? {}
        : { originName: query.originName }),
      ...(query.uploaderId === undefined
        ? {}
        : { createdBy: BigInt(query.uploaderId) }),
      page: query.page,
      pageSize: query.pageSize,
    });

    return {
      list: rows.map(toFileResponse),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async findOne(id: bigint): Promise<FileResponseDto> {
    return toFileResponse(await this.assertExists(id));
  }

  /**
   * 上传一批文件（1 到 FILE_MAX_COUNT 个）。字段名是 `files`。
   *
   * **先全部校验、再逐个落盘**：魔数不认的东西连一个字节都不该出现在磁盘上；
   * 反过来「先落盘再校验、不合法就删」在删失败时会留下攻击者写的文件。
   * 校验通过之后落盘中途失败，已写入的文件保留（各自独立、可用），
   * 客户端按返回重试缺的那几个。
   */
  async upload(
    files: readonly UploadedFile[],
    meta: RequestMeta,
    owner?: UploadOwnerDto,
  ): Promise<FileResponseDto[]> {
    const started = Date.now();

    try {
      // 归属先定型：成对校验不通过就一个字节都不落库
      const ownership = normalizeOwnership(owner);

      if (files.length === 0) {
        throw new BusinessException(
          ErrorCode.FILE_EMPTY,
          '文件内容为空',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (files.length > FILE_MAX_COUNT) {
        throw new BusinessException(
          ErrorCode.FILE_COUNT_EXCEEDED,
          `一次最多上传 ${FILE_MAX_COUNT} 个文件`,
          HttpStatus.BAD_REQUEST,
        );
      }

      // 全部通过校验才开始碰磁盘
      const prepared = files.map((file) => this.validate(file));

      const responses: FileResponseDto[] = [];
      for (const item of prepared) {
        responses.push(await this.persistOne(item, ownership));
      }

      await this.opLog.record({
        module: 'file',
        action: 'upload',
        targetType: 'SysFile',
        targetId: responses.map((item) => item.id).join(','),
        method: meta.method,
        path: meta.path,
        ...(meta.ip === undefined ? {} : { ip: meta.ip }),
        ...(meta.userAgent === undefined ? {} : { userAgent: meta.userAgent }),
        status: 1,
        after: responses.map((item) => ({
          id: item.id,
          originName: item.originName,
          size: item.size,
          sha256: item.sha256,
        })),
        durationMs: Date.now() - started,
      });
      return responses;
    } catch (error) {
      await this.opLog.record({
        module: 'file',
        action: 'upload',
        method: meta.method,
        path: meta.path,
        ...(meta.ip === undefined ? {} : { ip: meta.ip }),
        ...(meta.userAgent === undefined ? {} : { userAgent: meta.userAgent }),
        status: 0,
        errorCode: toErrorCode(error),
        errorMsg: toErrorMessage(error),
        durationMs: Date.now() - started,
      });
      throw error;
    }
  }

  private async persistOne(
    item: {
      originName: string;
      ext: string;
      mimeType: string;
      content: Buffer;
    },
    ownership: { ownerType: string | null; ownerId: bigint | null },
  ): Promise<FileResponseDto> {
    const storageName = FileStorage.buildStorageName(item.ext);
    const sha256 = createHash('sha256').update(item.content).digest('hex');

    await this.storage.save(storageName, item.content);

    try {
      const entity = await this.repository.create({
        originName: item.originName,
        storageName,
        ext: item.ext,
        mimeType: item.mimeType,
        size: item.content.length,
        sha256,
        ownerType: ownership.ownerType,
        ownerId: ownership.ownerId,
      });
      return toFileResponse(entity);
    } catch (error) {
      // 数据库没写进去，磁盘上那份就成了没人认领的字节。删掉它——
      // 「忘了清理孤儿文件」的表现是磁盘只增不减，且没有任何机制会说话。
      await this.storage.remove(storageName).catch(() => undefined);
      throw error;
    }
  }

  /** 软删除。磁盘文件不删——业务表里可能还有引用，删了就是引用悬空 */
  async remove(id: bigint, meta: RequestMeta): Promise<void> {
    const started = Date.now();
    const current = await this.assertExists(id);
    await this.repository.softDelete(id);

    await this.opLog.record({
      module: 'file',
      action: 'delete',
      targetType: 'SysFile',
      targetId: id.toString(),
      method: meta.method,
      path: meta.path,
      ...(meta.ip === undefined ? {} : { ip: meta.ip }),
      ...(meta.userAgent === undefined ? {} : { userAgent: meta.userAgent }),
      status: 1,
      before: {
        originName: current.originName,
        size: current.size,
        mimeType: current.mimeType,
        sha256: current.sha256,
      },
      durationMs: Date.now() - started,
    });
  }

  /** 取出可回放的文件内容；预览与下载共用同一条读路径 */
  async readContent(
    id: bigint,
  ): Promise<{ originName: string; mimeType: string; content: Buffer }> {
    const entity = await this.assertExists(id);
    return {
      originName: entity.originName,
      mimeType: entity.mimeType,
      content: await this.storage.read(entity.storageName),
    };
  }

  /**
   * `type` 显式给了就用它（下载固定 octet-stream，浏览器才会另存为而不是试着
   * 渲染）；没给就回文件自己的 mime，预览才能被直接渲染。
   *
   * **Content-Type 必须在这里给，不能在调用 serve 之前 setHeader**：readContent
   * 抛 404 时响应头已经带着 octet-stream 出门了，异常过滤器写出去的
   * `{ code: 28101, ... }` 顶着二进制 MIME 发给客户端——对方读到一坨 Buffer，
   * 根本看不出里面是 JSON 错误体。错误路径也得说人话。
   */
  async serve(
    id: bigint,
    disposition: 'inline' | 'attachment',
    type?: string,
  ): Promise<StreamableFile> {
    const file = await this.readContent(id);
    return new StreamableFile(file.content, {
      type: type ?? file.mimeType,
      disposition: contentDisposition(disposition, file.originName),
      length: file.content.length,
    });
  }

  /**
   * 归属校验：证明「这个文件是**这条业务记录**的附件」。
   * ownerType / ownerId 由**业务模块**给（它已经判过谁能看这条业务记录）。
   * 对不上一律 404——不是 403，否则就暴露了「这个 fileId 确实存在」。
   *
   * 四种形态（不存在 / 无归属 / 归属不符 / 相符）里前三种失败**同码同文案**：
   * `FILE_NOT_FOUND = 28101`、「文件不存在」。不许为「归属不符」单开错误码——
   * 单开码就告诉了调用方「这个 id 是存在的」，而那正是要藏的东西。
   */
  async assertOwnedBy(
    fileId: string,
    ownerType: string,
    ownerId: string,
  ): Promise<void> {
    // 对外字符串进来，BigInt() 一次（BIGINT 直接 JSON 化会抛）
    const entity = await this.repository.findById(BigInt(fileId));
    if (entity === null) {
      // 不存在 / 已软删（findById 已滤掉软删行）
      throw this.fileNotFound();
    }
    if (entity.ownerType === null || entity.ownerId === null) {
      // fail-closed：没归属就不是任何业务记录的附件
      throw this.fileNotFound();
    }
    if (entity.ownerType !== ownerType || entity.ownerId !== BigInt(ownerId)) {
      // 归属不符——同码同文案，不暴露「这个 id 存在」
      throw this.fileNotFound();
    }
    // 归属相符：通过，不抛
  }

  /**
   * 认领无归属文件：草稿阶段先上传（不挂 owner），提交后绑到业务记录。
   *
   * 只允许**上传人本人**认领；已被别的记录占用 / 不是本人上传 → 同 404，
   * 不暴露文件存在性。已属于本记录时幂等通过。
   */
  async claimOwnedBy(
    fileId: string,
    ownerType: string,
    ownerId: string,
    uploaderId: bigint,
  ): Promise<void> {
    const entity = await this.repository.findById(BigInt(fileId));
    if (entity === null) {
      throw this.fileNotFound();
    }
    if (entity.ownerType !== null || entity.ownerId !== null) {
      if (
        entity.ownerType === ownerType &&
        entity.ownerId === BigInt(ownerId)
      ) {
        return;
      }
      throw this.fileNotFound();
    }
    if (entity.createdBy !== uploaderId) {
      throw this.fileNotFound();
    }
    await this.repository.updateOwner(entity.id, ownerType, BigInt(ownerId));
  }

  // ── 校验 ──────────────────────────────────────────────────────

  private validate(file: UploadedFile | undefined): {
    originName: string;
    ext: string;
    mimeType: string;
    content: Buffer;
  } {
    if (file === undefined || file.buffer.length === 0) {
      // 「没给文件」与「给了个 0 字节的文件」对调用方是同一件事：
      // 这次请求没带来可存的内容。
      throw new BusinessException(
        ErrorCode.FILE_EMPTY,
        '文件内容为空',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (file.size > this.maxBytes || file.buffer.length > this.maxBytes) {
      throw new BusinessException(
        ErrorCode.FILE_TOO_LARGE,
        `文件超过大小上限（${this.maxBytes} 字节）`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const originName = normalizeOriginName(file.originalname);
    const ext = extractExt(originName);
    const type = findTypeByExt(ext);
    if (type === undefined) {
      throw new BusinessException(
        ErrorCode.FILE_TYPE_FORBIDDEN,
        '不支持的文件类型',
        HttpStatus.BAD_REQUEST,
      );
    }

    // 魔数说了算，客户端声明的 Content-Type 一律不信。
    // 它是攻击者可以随便写的字段——用它做判定等于把开关交出去。
    const head = file.buffer.subarray(0, MAGIC_HEAD_BYTES);
    if (!type.matches(head)) {
      throw new BusinessException(
        ErrorCode.FILE_MAGIC_MISMATCH,
        '文件内容与扩展名不符',
        HttpStatus.BAD_REQUEST,
      );
    }

    return {
      originName,
      ext: type.exts[0],
      mimeType: type.mime,
      content: file.buffer,
    };
  }

  private async assertExists(id: bigint) {
    const entity = await this.repository.findById(id);
    if (entity === null) {
      throw this.fileNotFound();
    }
    return entity;
  }

  /**
   * 「文件不存在」的唯一出处：assertExists 与 assertOwnedBy 的三种失败
   * 都从这里取异常，同码同文案由构造保证，不靠复制粘贴保持一致。
   */
  private fileNotFound(): BusinessException {
    return new BusinessException(
      ErrorCode.FILE_NOT_FOUND,
      '文件不存在',
      HttpStatus.NOT_FOUND,
    );
  }
}

/** 只保留文件名本体：Windows 的 multipart 会带上 `C:\fakepath\` 前缀 */
function normalizeOriginName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? raw;
  let cleaned = '';
  for (const char of base) {
    const code = char.codePointAt(0) ?? 0;
    // 控制字符（含 CR / LF）能逃出 Content-Disposition，一律丢掉
    if (code >= 0x20 && code !== 0x7f) {
      cleaned += char;
    }
  }
  return cleaned.slice(0, 255) || 'file';
}

function extractExt(name: string): string {
  const dot = name.lastIndexOf('.');
  // `.bashrc` 这类点开头的不算扩展名；结尾是点的也不算
  if (dot <= 0 || dot === name.length - 1) {
    return '';
  }
  return name.slice(dot + 1).toLowerCase();
}

/**
 * 归属两字段**成对**出现：两个一起给，或都不给（跨字段规则在 service 里判，
 * 同 permission.service.ts 的 assertTypeCodeConsistent；DTO 只管单字段）。
 * 空串视同没给（同 permission.service.ts 的 normalizeOptional——表单里空输入框
 * 提交上来的是 ''，不是 undefined）。
 * 只给一个 → 400 / `PARAM_INVALID = 10001`：半套归属比没有归属更坏，
 * 它会造出「文件属于某个只存在一半的对象」这种查不出来的错觉。
 */
function normalizeOwnership(owner: UploadOwnerDto | undefined): {
  ownerType: string | null;
  ownerId: bigint | null;
} {
  const ownerType =
    owner?.ownerType === undefined || owner.ownerType === ''
      ? null
      : owner.ownerType;
  const ownerIdRaw =
    owner?.ownerId === undefined || owner.ownerId === '' ? null : owner.ownerId;
  if ((ownerType === null) !== (ownerIdRaw === null)) {
    throw new BusinessException(
      ErrorCode.PARAM_INVALID,
      '归属必须成对给出：ownerType 与 ownerId 同时提供，或都不提供',
      HttpStatus.BAD_REQUEST,
    );
  }
  return {
    ownerType,
    // 对外字符串进来，BigInt() 一次
    ownerId: ownerIdRaw === null ? null : BigInt(ownerIdRaw),
  };
}

/**
 * 取出业务错误码写进操作日志。
 *
 * `BusinessException` 把 `{code, message, data}` 作为**响应体**交给 Nest，
 * 自己身上没有 `.code` 属性——只看 `error.code` 会把每一次业务失败
 * （类型不合法、超出上限、魔数不符……）都记成 10000，
 * 而操作日志的价值恰恰在于「失败在哪个码上」。
 */
function toErrorCode(error: unknown): number {
  if (!(error instanceof BusinessException)) {
    return ErrorCode.INTERNAL_ERROR;
  }
  const body: unknown = error.getResponse();
  const code =
    typeof body === 'object' && body !== null
      ? (body as { code?: unknown }).code
      : undefined;
  return typeof code === 'number' ? code : ErrorCode.INTERNAL_ERROR;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '上传失败';
}
