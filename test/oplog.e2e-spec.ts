import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { ErrorCode } from '../src/common/constants/error-code';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import type { OpLogPageResponseDto } from '../src/modules/oplog/dto/oplog.dto';
import type { OpLogResponseDto } from '../src/modules/oplog/dto/oplog-response.dto';
import {
  authedAgent,
  clearRedisKeys,
  clearBusinessTables,
  clearModuleTables,
  loginAs,
  seedSuperAdmin,
  type E2eApi,
} from './e2e-helpers';

/** 合法 PNG 头；本套件用它触发一条真实的 file.upload 日志 */
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

describe('操作日志 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let api: E2eApi;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);

    await clearBusinessTables(prisma);
    await clearModuleTables(prisma);
    await clearRedisKeys(redis);

    const admin = await seedSuperAdmin(prisma);
    const tokens = await loginAs(app, admin.username, admin.password);
    api = authedAgent(app, tokens.accessToken);

    // 现在只有文件模块写日志。上传一次，后面几条用例读的就是这条真日志，
    // 不是造出来的行——「日志确实长在业务路径上」这件事得由证据撑着。
    await api
      .post('/files')
      .attach('files', PNG, { filename: 'a.png' })
      .expect(201);
  });

  afterAll(async () => {
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
    }
  });

  it('1. 只读：POST / PUT / DELETE /op-logs 都没有路由', async () => {
    // append-only 不靠「约定不许删」，而是没有入口 + Prisma 扩展直接拒写
    for (const call of [
      () =>
        request(app.getHttpServer() as Server)
          .post('/op-logs')
          .send({}),
      () =>
        request(app.getHttpServer() as Server)
          .put('/op-logs/1')
          .send({}),
      () => request(app.getHttpServer() as Server).delete('/op-logs/1'),
    ]) {
      const response = await call();
      expect(response.status).toBe(404);
    }
  });

  it('2. 列表能读到刚写的那条 file.upload，且快照、操作人都在', async () => {
    const response = await api
      .get('/op-logs?module=file&action=upload')
      .expect(200);
    const body = response.body as ResponseEnvelope<OpLogPageResponseDto>;

    expect(body.code).toBe(0);
    expect(body.data.total).toBe(1);
    const row = body.data.list[0];
    expect(row).toMatchObject({
      module: 'file',
      action: 'upload',
      targetType: 'SysFile',
      method: 'POST',
      path: '/files',
      status: 1,
    });
    expect(row.operatorName).toBe('admin');
    expect(row.operatorId).toMatch(/^\d+$/);
    expect(typeof row.durationMs).toBe('number');
    // after 是写入方决定形状的快照；文件模块给的是 id / originName / size / sha256
    expect(Array.isArray(row.after)).toBe(true);
  });

  it('3. 失败的那次上传也留痕，status=0 且带 errorCode', async () => {
    const before = (
      await api.get('/op-logs?module=file&action=upload&status=0').expect(200)
    ).body as ResponseEnvelope<OpLogPageResponseDto>;

    await api
      .post('/files')
      .attach('files', Buffer.from('not a png'), { filename: 'x.png' })
      .expect(400);

    const after = (
      await api.get('/op-logs?module=file&action=upload&status=0').expect(200)
    ).body as ResponseEnvelope<OpLogPageResponseDto>;

    expect(after.data.total).toBe(before.data.total + 1);
    const row = after.data.list[0];
    expect(row.status).toBe(0);
    expect(row.errorCode).toBe(ErrorCode.FILE_MAGIC_MISMATCH);
  });

  it('4. 详情：存在 → 回全字段；不存在 → 404 / 27101', async () => {
    const list = (
      await api.get('/op-logs?module=file&action=delete').expect(200)
    ).body as ResponseEnvelope<OpLogPageResponseDto>;

    const missing = await api.get('/op-logs/999999').expect(404);
    expect((missing.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.OP_LOG_NOT_FOUND,
    );

    // 取一条真实存在的
    await api
      .post('/files')
      .attach('files', PNG, { filename: 'b.png' })
      .expect(201);
    const found = (await api.get('/op-logs?module=file').expect(200))
      .body as ResponseEnvelope<OpLogPageResponseDto>;
    const target = found.data.list[0];

    const detail = await api.get(`/op-logs/${target.id}`).expect(200);
    const row = (detail.body as ResponseEnvelope<OpLogResponseDto>).data;
    expect(row.id).toBe(target.id);
    expect(row).toHaveProperty('before');
    expect(row).toHaveProperty('after');
    expect(row).toHaveProperty('userAgent');
    expect(list.data.total).toBe(0); // 至此还没有 delete 动作
  });

  it('5. 按时间窗过滤：起点晚于一切 → 空列表', async () => {
    const response = await api
      .get('/op-logs?startTime=2099-01-01T00:00:00.000Z')
      .expect(200);
    const body = response.body as ResponseEnvelope<OpLogPageResponseDto>;
    expect(body.data).toMatchObject({ list: [], total: 0 });
  });

  it('6. Prisma 扩展把这张表焊死成 append-only：update / delete 直接抛', async () => {
    const row = await prisma.client.sysOpLog.findFirstOrThrow({});
    await expect(
      prisma.client.sysOpLog.update({
        where: { id: row.id },
        data: { action: 'tampered' },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.client.sysOpLog.delete({ where: { id: row.id } }),
    ).rejects.toThrow(/append-only/);

    // 连 includingDeleted 也过不去——那道墙在软删除分支之前
    await expect(
      prisma.includingDeleted.sysOpLog.deleteMany({}),
    ).rejects.toThrow(/append-only/);

    const still = await prisma.client.sysOpLog.findFirstOrThrow({
      where: { id: row.id },
    });
    expect(still.action).toBe(row.action);
  });
});
