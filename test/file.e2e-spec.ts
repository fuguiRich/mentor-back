import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { HttpStatus, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { ErrorCode } from '../src/common/constants/error-code';
import { BusinessException } from '../src/common/errors/business.exception';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import { FileService } from '../src/modules/file/file.service';
import type { FilePageResponseDto } from '../src/modules/file/dto/file.dto';
import type { FileResponseDto } from '../src/modules/file/dto/file-response.dto';
import {
  authedAgent,
  clearRedisKeys,
  clearBusinessTables,
  clearModuleTables,
  loginAs,
  seedSuperAdmin,
  type E2eApi,
} from './e2e-helpers';

/** 合法 PNG 头（8 字节签名），后面随便垫——判魔数只看签名 */
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

/** 两级散列目录下的叶子文件数（file.storage.ts 的 <aa>/<bb>/<name>） */
async function countStoredFiles(root: string): Promise<number> {
  let total = 0;
  for (const a of await readdir(root, { withFileTypes: true })) {
    if (!a.isDirectory()) continue;
    for (const b of await readdir(join(root, a.name), {
      withFileTypes: true,
    })) {
      if (!b.isDirectory()) continue;
      total += (await readdir(join(root, a.name, b.name))).length;
    }
  }
  return total;
}

describe('文件 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let api: E2eApi;
  // assertOwnedBy 没有 HTTP 面（业务路由归 Task 16 / 17），从容器里取服务直调
  let fileService: FileService;
  let root: string;
  let savedRoot: string | undefined;
  let savedMaxBytes: string | undefined;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'general-back-file-e2e-'));

    // 配置在 ConfigModule 初始化时就定死了，必须赶在建应用之前改环境变量。
    // 用完恢复：jest e2e 是单进程串行跑的，留着会污染后面的套件。
    savedRoot = process.env.FILE_ROOT;
    savedMaxBytes = process.env.FILE_MAX_BYTES;
    process.env.FILE_ROOT = root;
    process.env.FILE_MAX_BYTES = '1024';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    fileService = app.get(FileService);

    await clearBusinessTables(prisma);
    await clearModuleTables(prisma);
    await clearRedisKeys(redis);

    const admin = await seedSuperAdmin(prisma);
    const tokens = await loginAs(app, admin.username, admin.password);
    api = authedAgent(app, tokens.accessToken);
  });

  afterAll(async () => {
    if (savedRoot === undefined) delete process.env.FILE_ROOT;
    else process.env.FILE_ROOT = savedRoot;
    if (savedMaxBytes === undefined) delete process.env.FILE_MAX_BYTES;
    else process.env.FILE_MAX_BYTES = savedMaxBytes;

    try {
      if (prisma !== undefined) {
        await clearBusinessTables(prisma);
        await clearModuleTables(prisma);
      }
      if (redis !== undefined) {
        await clearRedisKeys(redis);
      }
    } finally {
      if (app !== undefined) {
        await app.close();
      }
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function upload(
    parts: Array<{ name: string; content: Buffer; contentType?: string }>,
  ): request.Test {
    let req = api.post('/files');
    for (const part of parts) {
      req = req.attach('files', part.content, {
        filename: part.name,
        contentType: part.contentType ?? 'application/octet-stream',
      });
    }
    return req;
  }

  /** 上传一个带归属（MentorApplication / 7）的 PNG，返回新建的文件记录 */
  async function uploadOwned(): Promise<FileResponseDto> {
    const created = await api
      .post('/files')
      .attach('files', PNG, {
        filename: 'owned.png',
        contentType: 'application/octet-stream',
      })
      .field('ownerType', 'MentorApplication')
      .field('ownerId', '7')
      .expect(201);
    return (created.body as ResponseEnvelope<FileResponseDto[]>).data[0];
  }

  async function captureFailure(
    p: Promise<unknown>,
  ): Promise<BusinessException> {
    try {
      await p;
    } catch (error) {
      if (error instanceof BusinessException) {
        return error;
      }
      throw error;
    }
    throw new Error('期望抛出，但它通过了');
  }

  it('1. 上传合法 PNG → 201，回 1 条记录，落盘 1 个字节块', async () => {
    const before = await countStoredFiles(root);
    const response = await upload([
      { name: '成绩单.png', content: PNG },
    ]).expect(201);
    const body = response.body as ResponseEnvelope<FileResponseDto[]>;

    expect(body.code).toBe(0);
    expect(body.data).toHaveLength(1);
    // 这里刻意用中文名：busboy 默认按 latin1 解 multipart 头里的 filename，
    // 少了 `defParamCharset: 'utf8'` 这条就会存成「æç»©å.png」。
    expect(body.data[0]).toMatchObject({
      originName: '成绩单.png',
      ext: 'png',
      mimeType: 'image/png',
      size: PNG.length,
    });
    expect(body.data[0].id).toMatch(/^\d+$/);
    expect(body.data[0].sha256).toHaveLength(64);
    expect(body.data[0].previewUrl).toBe(`/files/${body.data[0].id}/preview`);
    expect(body.data[0].downloadUrl).toBe(`/files/${body.data[0].id}/download`);
    expect(await countStoredFiles(root)).toBe(before + 1);
  });

  it('2. 一个文件都不带 → 400 / 28104', async () => {
    const response = await api.post('/files').expect(400);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.FILE_EMPTY);
  });

  it('3. 一次 11 个 → 400 / 28105，且一个都不落盘', async () => {
    const before = await countStoredFiles(root);
    const parts = Array.from({ length: 11 }, (_, i) => ({
      name: `f${i}.png`,
      content: PNG,
    }));
    const response = await upload(parts).expect(400);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FILE_COUNT_EXCEEDED,
    );
    expect(await countStoredFiles(root)).toBe(before);
  });

  it('4. 超过大小上限 → 28103（multer 先拦，落成 413）', async () => {
    // 上限配的是 1024 字节，塞 2KB。这里的 413 是 UploadErrorInterceptor 的产物：
    // 业务码 28103 才是客户端要认的那个，HTTP 状态码只是「太大了」的传输语义
    const response = await upload([
      { name: 'big.png', content: Buffer.concat([PNG, Buffer.alloc(2048)]) },
    ]).expect(413);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FILE_TOO_LARGE,
    );
  });

  it('5. 扩展名不在白名单 → 400 / 28102（svg 与 txt 一律拒）', async () => {
    for (const name of ['a.svg', 'a.txt', 'a.html', '.bashrc', 'noext']) {
      const response = await upload([{ name, content: PNG }]).expect(400);
      expect((response.body as ResponseEnvelope<null>).code).toBe(
        ErrorCode.FILE_TYPE_FORBIDDEN,
      );
    }
  });

  it('6. 扩展名对但魔数不对 → 400 / 28106；客户端声明的 mimetype 一律不信', async () => {
    // 这条是整个上传面的红线：mimetype 是攻击者可写的字段
    const response = await upload([
      {
        name: 'a.png',
        content: PDF,
        // 刻意谎报成 png——判定若看这里就会放行
        contentType: 'image/png',
      },
    ]).expect(400);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FILE_MAGIC_MISMATCH,
    );
  });

  it('7. **先全部校验再落盘**：第二个文件不合法，第一个也不进库、不进磁盘', async () => {
    const before = await countStoredFiles(root);
    const rowsBefore = await prisma.includingDeleted.sysFile.count({});

    const response = await upload([
      { name: 'ok.png', content: PNG },
      { name: 'bad.txt', content: Buffer.from('x') },
    ]).expect(400);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FILE_TYPE_FORBIDDEN,
    );

    expect(await countStoredFiles(root)).toBe(before);
    expect(await prisma.includingDeleted.sysFile.count({})).toBe(rowsBefore);
  });

  it('8. 预览：Content-Disposition 是 inline，回的是字节流不是 JSON 外壳', async () => {
    const created = await upload([{ name: '看我.png', content: PNG }]).expect(
      201,
    );
    const file = (created.body as ResponseEnvelope<FileResponseDto[]>).data[0];

    const response = await api.get(`/files/${file.id}/preview`).expect(200);
    expect(response.headers['content-disposition']).toContain('inline');
    // 中文原名走 RFC 5987；同时给纯 ASCII 兜底
    expect(response.headers['content-disposition']).toContain(
      "filename*=UTF-8''",
    );
    expect(Buffer.compare(response.body as Buffer, PNG)).toBe(0);
  });

  it('9. 下载：Content-Disposition 是 attachment，按原始文件名另存', async () => {
    const created = await upload([{ name: '存档.pdf', content: PDF }]).expect(
      201,
    );
    const file = (created.body as ResponseEnvelope<FileResponseDto[]>).data[0];

    const response = await api.get(`/files/${file.id}/download`).expect(200);
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['content-disposition']).toContain(
      "filename*=UTF-8''",
    );
    expect(Buffer.compare(response.body as Buffer, PDF)).toBe(0);
  });

  it('10. 软删 → 204；再取内容 404 / 28101，磁盘那份**留着**', async () => {
    const created = await upload([{ name: '删我.png', content: PNG }]).expect(
      201,
    );
    const file = (created.body as ResponseEnvelope<FileResponseDto[]>).data[0];
    const before = await countStoredFiles(root);

    await api.delete(`/files/${file.id}`).expect(204);

    const gone = await api.get(`/files/${file.id}/preview`).expect(404);
    expect((gone.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FILE_NOT_FOUND,
    );
    // 删的是索引不是字节：业务表可能还引用着它，磁盘清理属于归档策略
    expect(await countStoredFiles(root)).toBe(before);
  });

  it('11. 原始文件名里的目录前缀 / 控制字符被剥掉', async () => {
    const created = await upload([
      { name: 'C:\\fakepath\\..\\evil\r\n.png', content: PNG },
    ]).expect(201);
    const file = (created.body as ResponseEnvelope<FileResponseDto[]>).data[0];
    // 控制字符是**丢掉**不是换成 `_`：这一列只是元数据
    expect(file.originName).toBe('evil.png');
  });

  it('12. 字段名不对 → 28105（与超数量共用一个码，multer 只给这么多信息）', async () => {
    const response = await api
      .post('/files')
      .attach('not_files', PNG, { filename: 'a.png' })
      .expect(400);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FILE_COUNT_EXCEEDED,
    );
  });

  it('13. 列表按上传时间倒序，可按原名模糊筛', async () => {
    const response = await api.get('/files?originName=看我').expect(200);
    const body = response.body as ResponseEnvelope<FilePageResponseDto>;
    expect(body.data.total).toBe(1);
    expect(body.data.list[0].originName).toBe('看我.png');
  });

  it('14. 预览 / 下载一个不存在的 id → 404 / 28101，且错误体顶着 JSON 出门', async () => {
    // Content-Type 必须在**读到文件之后**才定。download 若在调用读路径之前就
    // setHeader('Content-Type', 'application/octet-stream')，异常过滤器写的
    // { code: 28101, ... } 会顶着二进制 MIME 发回去——客户端拿到一坨 Buffer，
    // body.code 是 undefined，只能靠猜里面是不是 JSON。
    for (const path of ['/files/999999/preview', '/files/999999/download']) {
      const response = await api.get(path).expect(404);
      expect(response.headers['content-type']).toContain('application/json');
      expect((response.body as ResponseEnvelope<null>).code).toBe(
        ErrorCode.FILE_NOT_FOUND,
      );
    }
  });

  it('15. 路径穿越原名进不了路径：落盘名仍是 uuid + ext，仍在 FILE_ROOT 内', async () => {
    const before = await countStoredFiles(root);

    // 无扩展名的字面原名 → 拦在类型白名单（28102），连落盘环节都到不了
    const rejected = await upload([
      { name: '../../../etc/passwd', content: PNG },
    ]).expect(400);
    expect((rejected.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FILE_TYPE_FORBIDDEN,
    );

    // 带合法扩展名的穿越原名 → 能过，但落盘名与原名无关
    const created = await upload([
      { name: '../../../etc/passwd.png', content: PNG },
    ]).expect(201);
    const file = (created.body as ResponseEnvelope<FileResponseDto[]>).data[0];
    // 原始名只进库里（回显），磁盘名是 uuid + ext
    expect(file.originName).toBe('passwd.png');

    const row = await prisma.includingDeleted.sysFile.findFirst({
      where: { id: BigInt(file.id) },
    });
    expect(row?.storageName).toMatch(/^[0-9a-f-]{36}\.png$/);
    const storageName = row?.storageName ?? '';
    // 就在 FILE_ROOT 的两级散列目录下（access 不抛 = 文件真实存在于该路径）
    await access(
      join(root, storageName.slice(0, 2), storageName.slice(2, 4), storageName),
    );
    expect(await countStoredFiles(root)).toBe(before + 1);
  });

  it('16. 上传带 ownerType + ownerId → 两列落库；回显里 ownerId 是字符串', async () => {
    const response = await api
      .post('/files')
      .attach('files', PNG, {
        filename: '归属.png',
        contentType: 'application/octet-stream',
      })
      .field('ownerType', 'MentorApplication')
      .field('ownerId', '7')
      .expect(201);
    const file = (response.body as ResponseEnvelope<FileResponseDto[]>).data[0];

    expect(file.ownerType).toBe('MentorApplication');
    expect(file.ownerId).toBe('7');
    expect(typeof file.ownerId).toBe('string');

    const row = await prisma.includingDeleted.sysFile.findFirst({
      where: { id: BigInt(file.id) },
    });
    expect(row?.ownerType).toBe('MentorApplication');
    expect(row?.ownerId).toBe(7n);
  });

  it('17. 归属只给一个字段 → 400 / 10001，文件不落库', async () => {
    const before = await countStoredFiles(root);
    const rowsBefore = await prisma.includingDeleted.sysFile.count({});

    const onlyType = await api
      .post('/files')
      .attach('files', PNG, {
        filename: 'a.png',
        contentType: 'application/octet-stream',
      })
      .field('ownerType', 'MentorApplication')
      .expect(400);
    expect((onlyType.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PARAM_INVALID,
    );

    const onlyId = await api
      .post('/files')
      .attach('files', PNG, {
        filename: 'a.png',
        contentType: 'application/octet-stream',
      })
      .field('ownerId', '7')
      .expect(400);
    expect((onlyId.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PARAM_INVALID,
    );

    expect(await countStoredFiles(root)).toBe(before);
    expect(await prisma.includingDeleted.sysFile.count({})).toBe(rowsBefore);
  });

  it('18. assertOwnedBy 归属相符 → 通过（不抛）', async () => {
    const file = await uploadOwned();
    await expect(
      fileService.assertOwnedBy(file.id, 'MentorApplication', '7'),
    ).resolves.toBeUndefined();
  });

  it('19. assertOwnedBy 归属不符 → 404 / 28101（不是 403——403 就暴露「这个 id 存在」）', async () => {
    const file = await uploadOwned();

    for (const [ownerType, ownerId] of [
      ['MentorApplication', '8'],
      ['OtherType', '7'],
    ] as const) {
      const error = await captureFailure(
        fileService.assertOwnedBy(file.id, ownerType, ownerId),
      );
      expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
      expect(error.getResponse()).toEqual({
        code: ErrorCode.FILE_NOT_FOUND,
        message: '文件不存在',
        data: null,
      });
    }
  });

  it('20. assertOwnedBy 文件无归属 → 404 / 28101（fail-closed）', async () => {
    const created = await upload([{ name: 'n.png', content: PNG }]).expect(201);
    const file = (created.body as ResponseEnvelope<FileResponseDto[]>).data[0];
    expect(file.ownerType).toBeNull();

    const error = await captureFailure(
      fileService.assertOwnedBy(file.id, 'MentorApplication', '7'),
    );
    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(error.getResponse()).toEqual({
      code: ErrorCode.FILE_NOT_FOUND,
      message: '文件不存在',
      data: null,
    });
  });

  it('21. 文件不存在与归属不符 / 无归属**同码同文案**（28101 / 「文件不存在」）', async () => {
    const notFound = await captureFailure(
      fileService.assertOwnedBy('999999', 'MentorApplication', '7'),
    );
    const owned = await uploadOwned();
    const mismatch = await captureFailure(
      fileService.assertOwnedBy(owned.id, 'MentorApplication', '8'),
    );
    const created = await upload([{ name: 'n2.png', content: PNG }]).expect(
      201,
    );
    const noOwnerFile = (created.body as ResponseEnvelope<FileResponseDto[]>)
      .data[0];
    const noOwner = await captureFailure(
      fileService.assertOwnedBy(noOwnerFile.id, 'MentorApplication', '7'),
    );

    expect(mismatch.getResponse()).toEqual(notFound.getResponse());
    expect(noOwner.getResponse()).toEqual(notFound.getResponse());
    expect(notFound.getResponse()).toEqual({
      code: ErrorCode.FILE_NOT_FOUND,
      message: '文件不存在',
      data: null,
    });
  });

  it('22. 归属定型：POST /files 之外没有任何写口能改 ownerType / ownerId', async () => {
    const file = await uploadOwned();

    // 路由面上 /files/{id} 只有 DELETE（契约清单钉死）；其余写法都无路由。
    // 逐条 await，不预构请求数组——supertest 的 Test 在 end() 时才绑端口，
    // 预先造一排会撞上 formatServerUrl 的地址竞态。
    await api
      .put(`/files/${file.id}`)
      .send({ ownerType: 'Other', ownerId: '8' })
      .expect(404);
    await api
      .patch(`/files/${file.id}`)
      .send({ ownerType: 'Other', ownerId: '8' })
      .expect(404);
    await api
      .post(`/files/${file.id}`)
      .send({ ownerType: 'Other', ownerId: '8' })
      .expect(404);

    // 两列原样——改归属的唯一办法是删了重传
    const row = await prisma.includingDeleted.sysFile.findFirst({
      where: { id: BigInt(file.id) },
    });
    expect(row?.ownerType).toBe('MentorApplication');
    expect(row?.ownerId).toBe(7n);
  });
});
