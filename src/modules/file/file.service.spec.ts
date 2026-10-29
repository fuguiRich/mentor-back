import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpStatus } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { ErrorCode } from '../../common/constants/error-code';
import { BusinessException } from '../../common/errors/business.exception';
import type { OpLogService } from '../oplog/oplog.service';
import type { FileRepository } from './file.repository';
import {
  FileService,
  type RequestMeta,
  type UploadedFile,
} from './file.service';

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

function file(overrides: Partial<UploadedFile> = {}): UploadedFile {
  return {
    originalname: 'a.png',
    mimetype: 'image/png',
    size: PNG.length,
    buffer: PNG,
    ...overrides,
  };
}

const META: RequestMeta = { method: 'POST', path: '/files' };

function build(options: {
  root: string;
  maxBytes?: number;
  createFails?: boolean;
  /** findById 的返回值；缺省 null（文件不存在） */
  findByIdResult?: Record<string, unknown> | null;
}): {
  service: FileService;
  created: Record<string, unknown>[];
  logged: Record<string, unknown>[];
} {
  const created: Record<string, unknown>[] = [];
  const logged: Record<string, unknown>[] = [];

  const repository = {
    create: (data: Record<string, unknown>): Promise<unknown> => {
      if (options.createFails) {
        return Promise.reject(new Error('db down'));
      }
      created.push(data);
      return Promise.resolve({
        id: BigInt(created.length),
        originName: data.originName,
        storageName: data.storageName,
        ext: data.ext,
        mimeType: data.mimeType,
        size: data.size,
        sha256: data.sha256,
        ownerType: data.ownerType ?? null,
        ownerId: data.ownerId ?? null,
        createdAt: new Date('2026-10-20T00:00:00.000Z'),
        createdBy: 1n,
      });
    },
    findMany: (): Promise<{ rows: unknown[]; total: number }> =>
      Promise.resolve({ rows: [], total: 0 }),
    findById: (): Promise<unknown> =>
      Promise.resolve(options.findByIdResult ?? null),
    softDelete: (): Promise<void> => Promise.resolve(),
  } as unknown as FileRepository;

  const opLog = {
    record: (input: Record<string, unknown>): Promise<void> => {
      logged.push(input);
      return Promise.resolve();
    },
  } as unknown as OpLogService;

  const config = {
    get: (key: string): unknown => {
      if (key === 'file.root') return options.root;
      if (key === 'file.maxBytes') return options.maxBytes ?? 1024;
      return undefined;
    },
  } as unknown as ConfigService<AppConfig, true>;

  return {
    service: new FileService(repository, opLog, config),
    created,
    logged,
  };
}

async function countFiles(root: string): Promise<number> {
  let total = 0;
  for (const shard of await readdir(root, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue;
    for (const leaf of await readdir(join(root, shard.name), {
      withFileTypes: true,
    })) {
      if (!leaf.isDirectory()) continue;
      total += (await readdir(join(root, shard.name, leaf.name))).length;
    }
  }
  return total;
}

describe('FileService.upload', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'general-back-file-svc-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('1. 一个文件都没有 → 28104', async () => {
    const { service } = build({ root });
    await expect(service.upload([], META)).rejects.toMatchObject({
      response: { code: ErrorCode.FILE_EMPTY },
    });
  });

  it('2. 超过 10 个 → 28105，且**一个都不校验、一个都不落盘**', async () => {
    const { service, created } = build({ root });
    const files = Array.from({ length: 11 }, () => file());

    await expect(service.upload(files, META)).rejects.toMatchObject({
      response: { code: ErrorCode.FILE_COUNT_EXCEEDED },
      status: HttpStatus.BAD_REQUEST,
    });
    expect(created).toEqual([]);
    expect(await countFiles(root)).toBe(0);
  });

  it('3. 0 字节文件 → 28104（「没给」和「给了个空的」是同一件事）', async () => {
    const { service } = build({ root });
    await expect(
      service.upload([file({ buffer: Buffer.alloc(0), size: 0 })], META),
    ).rejects.toMatchObject({ response: { code: ErrorCode.FILE_EMPTY } });
  });

  it('4. 超过大小上限 → 28103', async () => {
    const { service } = build({ root, maxBytes: 4 });
    await expect(service.upload([file()], META)).rejects.toMatchObject({
      response: { code: ErrorCode.FILE_TOO_LARGE },
    });
  });

  it('5. 扩展名不在白名单 → 28102（svg / txt 一律拒）', async () => {
    const { service } = build({ root });
    await expect(
      service.upload([file({ originalname: 'a.svg' })], META),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.FILE_TYPE_FORBIDDEN },
    });
    await expect(
      service.upload([file({ originalname: 'a.txt' })], META),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.FILE_TYPE_FORBIDDEN },
    });
  });

  it('6. 扩展名对但魔数不对 → 28106；客户端声明的 mimetype 一律不信', async () => {
    // 这条是整个上传面的红线：mimetype 是攻击者可写的字段。
    // 红绿可伪——把 `type.matches(head)` 换成 `file.mimetype === type.mime`
    // 就会绿，而一个 .png 里装的是 PHP 也能上传成功。
    const { service, created } = build({ root });
    await expect(
      service.upload(
        [
          file({
            originalname: 'a.png',
            mimetype: 'image/png',
            buffer: PDF,
            size: PDF.length,
          }),
        ],
        META,
      ),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.FILE_MAGIC_MISMATCH },
    });
    expect(created).toEqual([]);
  });

  it('7. **先全部校验再落盘**：第二个文件不合法，第一个也不会出现在磁盘上', async () => {
    // 反过来（先落盘再校验、不合法就删）在删失败时会留下攻击者写的文件。
    const { service, created } = build({ root });

    await expect(
      service.upload(
        [file({ originalname: 'ok.png' }), file({ originalname: 'bad.txt' })],
        META,
      ),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.FILE_TYPE_FORBIDDEN },
    });

    expect(created).toEqual([]);
    expect(await countFiles(root)).toBe(0);
  });

  it('8. 批次里 3 个都合法 → 3 个都落盘，返回 3 条', async () => {
    const { service, created } = build({ root });

    const result = await service.upload(
      [file({ originalname: 'a.png' }), file({ originalname: 'b.png' })],
      META,
    );

    expect(result).toHaveLength(2);
    expect(created).toHaveLength(2);
    expect(await countFiles(root)).toBe(2);
  });

  it('9. 数据库写失败 → 磁盘那份被删掉，不留孤儿字节', async () => {
    // 「忘了清理孤儿文件」的表现是磁盘只增不减，且没有任何机制会说话。
    const { service } = build({ root, createFails: true });

    await expect(service.upload([file()], META)).rejects.toThrow('db down');
    expect(await countFiles(root)).toBe(0);
  });

  it('10. 成功与失败都记一条操作日志', async () => {
    const ok = build({ root });
    await ok.service.upload([file()], META);
    expect(ok.logged).toHaveLength(1);
    expect(ok.logged[0]).toMatchObject({
      module: 'file',
      action: 'upload',
      status: 1,
    });

    const bad = build({ root });
    await bad.service
      .upload([file({ originalname: 'x.txt' })], META)
      .catch(() => undefined);
    expect(bad.logged).toHaveLength(1);
    expect(bad.logged[0]).toMatchObject({
      status: 0,
      errorCode: ErrorCode.FILE_TYPE_FORBIDDEN,
    });
  });

  it('11. 原始文件名里的目录前缀 / 控制字符被剥掉，只留文件名本体', async () => {
    const { service, created } = build({ root });

    await service.upload(
      [file({ originalname: 'C:\\fakepath\\..\\evil\r\n.png' })],
      META,
    );

    // 控制字符是**丢掉**不是换成 `_`：这一列只是元数据，
    // 真正决定内容的是 storageName（uuid），名字里少两个字符不丢信息。
    expect(created[0].originName).toBe('evil.png');
  });

  it('12. `.bashrc` / `name.` 这类不带扩展名 → 28102', async () => {
    const { service } = build({ root });
    for (const originalname of ['.bashrc', 'name.', 'noext']) {
      await expect(
        service.upload([file({ originalname })], META),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.FILE_TYPE_FORBIDDEN },
      });
    }
  });

  it('13. 带 ownerType + ownerId → 两列落库；回显里 ownerId 是字符串', async () => {
    const { service, created } = build({ root });

    const result = await service.upload([file()], META, {
      ownerType: 'MentorApplication',
      ownerId: '7',
    });

    expect(created[0]).toMatchObject({
      ownerType: 'MentorApplication',
      ownerId: 7n,
    });
    expect(result[0].ownerType).toBe('MentorApplication');
    expect(result[0].ownerId).toBe('7'); // 对外字符串，不是 bigint
    expect(typeof result[0].ownerId).toBe('string');
  });

  it('14. 只给一个字段 → 10001，一个字节都不落库', async () => {
    const { service, created } = build({ root });

    await expect(
      service.upload([file()], META, { ownerType: 'MentorApplication' }),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.PARAM_INVALID },
      status: HttpStatus.BAD_REQUEST,
    });
    await expect(
      service.upload([file()], META, { ownerId: '7' }),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.PARAM_INVALID },
      status: HttpStatus.BAD_REQUEST,
    });

    expect(created).toEqual([]);
    expect(await countFiles(root)).toBe(0);
  });

  it('15. 都不给 → 两列落 null（通用文件，现状不回归）', async () => {
    const { service, created } = build({ root });

    const result = await service.upload([file()], META);

    expect(created[0]).toMatchObject({ ownerType: null, ownerId: null });
    expect(result[0].ownerType).toBeNull();
    expect(result[0].ownerId).toBeNull();
  });
});

describe('FileService.assertOwnedBy', () => {
  const OWNER_TYPE = 'MentorApplication';
  const OWNER_ID = '7';

  function fileEntity(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      id: 1n,
      originName: 'a.png',
      storageName: 'ab/cd/uuid.png',
      ext: 'png',
      mimeType: 'image/png',
      size: 12,
      sha256: 'a'.repeat(64),
      ownerType: OWNER_TYPE,
      ownerId: 7n,
      createdAt: new Date('2026-10-20T00:00:00.000Z'),
      createdBy: 1n,
      ...overrides,
    };
  }

  /** assertOwnedBy 不碰磁盘，root 不会真用到 */
  function serviceWith(
    entityValue: Record<string, unknown> | null,
  ): FileService {
    return build({ root: 'unused', findByIdResult: entityValue }).service;
  }

  async function captureFailure(p: Promise<void>): Promise<BusinessException> {
    try {
      await p;
    } catch (error) {
      if (error instanceof BusinessException) {
        return error;
      }
      throw error;
    }
    throw new Error('期望 assertOwnedBy 抛出，但它通过了');
  }

  it('形态 4：归属相符 → 通过（不抛）', async () => {
    await expect(
      serviceWith(fileEntity()).assertOwnedBy('1', OWNER_TYPE, OWNER_ID),
    ).resolves.toBeUndefined();
  });

  it('形态 3：归属不符 → 404 / 28101（不是 403——403 就暴露「这个 id 存在」）', async () => {
    await expect(
      serviceWith(fileEntity()).assertOwnedBy('1', OWNER_TYPE, '8'),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.FILE_NOT_FOUND, message: '文件不存在' },
      status: HttpStatus.NOT_FOUND,
    });
    await expect(
      serviceWith(fileEntity()).assertOwnedBy('1', 'OtherType', OWNER_ID),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.FILE_NOT_FOUND, message: '文件不存在' },
      status: HttpStatus.NOT_FOUND,
    });
  });

  it('形态 2：文件无归属 → 404 / 28101（fail-closed：不是任何业务记录的附件）', async () => {
    await expect(
      serviceWith(fileEntity({ ownerType: null, ownerId: null })).assertOwnedBy(
        '1',
        OWNER_TYPE,
        OWNER_ID,
      ),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.FILE_NOT_FOUND, message: '文件不存在' },
      status: HttpStatus.NOT_FOUND,
    });
  });

  it('形态 1：文件不存在（含已软删——findById 查不到）→ 404 / 28101', async () => {
    await expect(
      serviceWith(null).assertOwnedBy('999', OWNER_TYPE, OWNER_ID),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.FILE_NOT_FOUND, message: '文件不存在' },
      status: HttpStatus.NOT_FOUND,
    });
  });

  it('三种失败同码同文案——单开码就暴露「这个 id 存在」', async () => {
    const notFound = await captureFailure(
      serviceWith(null).assertOwnedBy('999', OWNER_TYPE, OWNER_ID),
    );
    const noOwner = await captureFailure(
      serviceWith(fileEntity({ ownerType: null, ownerId: null })).assertOwnedBy(
        '1',
        OWNER_TYPE,
        OWNER_ID,
      ),
    );
    const mismatch = await captureFailure(
      serviceWith(fileEntity()).assertOwnedBy('1', OWNER_TYPE, '8'),
    );

    expect(noOwner.getResponse()).toEqual(notFound.getResponse());
    expect(mismatch.getResponse()).toEqual(notFound.getResponse());
    expect(notFound.getResponse()).toEqual({
      code: ErrorCode.FILE_NOT_FOUND,
      message: '文件不存在',
      data: null,
    });
    expect(notFound.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(noOwner.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(mismatch.getStatus()).toBe(HttpStatus.NOT_FOUND);
  });
});
