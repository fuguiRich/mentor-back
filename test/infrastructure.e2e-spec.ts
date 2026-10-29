import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import {
  Body,
  ConflictException,
  Controller,
  Get,
  Logger,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { IsString } from 'class-validator';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ErrorCode } from '../src/common/constants/error-code';
import { NoEnvelope } from '../src/common/decorators/no-envelope.decorator';
import { Public } from '../src/common/decorators/public.decorator';
import type { FieldErrorDto } from '../src/common/dto/field-error.dto';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';

class ProbeBodyDto {
  @IsString()
  name!: string;
}

/** 临时探针：只用来说明全局件的效果，不参与业务。
 *  @Public() 是刻意的：本套件测的是响应外壳 / 管道 / 异常过滤器，
 *  不是鉴权。鉴权的证据在 test/auth.e2e-spec.ts。 */
@ApiTags('测试探针')
@Public()
@Controller('__probe')
class ProbeController {
  @Get('ok')
  ok(): { hello: string } {
    return { hello: 'world' };
  }

  @Post('echo')
  echo(@Body() body: ProbeBodyDto): ProbeBodyDto {
    return body;
  }

  @Get('boom')
  boom(): never {
    throw new Error('internal detail: sentinel-LEAK-CANARY');
  }

  @Get('prisma-missing')
  prismaMissing(): never {
    throw new Prisma.PrismaClientKnownRequestError('记录不存在', {
      code: 'P2025',
      clientVersion: 'test',
    });
  }

  @Get('conflict')
  conflict(): never {
    throw new ConflictException('重复冲突');
  }

  @Get('raw')
  @NoEnvelope()
  raw(): { raw: boolean } {
    return { raw: true };
  }
}

describe('横切基础设施 (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ProbeController],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('成功响应被补上统一外壳', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/__probe/ok')
      .expect(200);

    const body = response.body as ResponseEnvelope<{ hello: string }>;

    expect(body.code).toBe(0);
    expect(body.message).toBe('ok');
    expect(body.data).toEqual({ hello: 'world' });
  });

  it('外壳里带 traceId，且同一响应的 traceId 非空', async () => {
    const response = await request(app.getHttpServer() as Server).get(
      '/__probe/ok',
    );

    const body = response.body as ResponseEnvelope<{ hello: string }>;

    expect(typeof body.traceId).toBe('string');
    expect(body.traceId).toHaveLength(36);
  });

  it('未声明的字段被拒绝，且能定位到字段名', async () => {
    const response = await request(app.getHttpServer() as Server)
      .post('/__probe/echo')
      .send({ name: 'a', unexpected: 1 })
      .expect(400);

    const body = response.body as ResponseEnvelope<{ fields: FieldErrorDto[] }>;

    expect(body.code).toBe(ErrorCode.PARAM_INVALID);
    expect(body.data.fields[0].field).toBe('unexpected');
  });

  it('字段类型不对时错误信息能定位到该字段', async () => {
    const response = await request(app.getHttpServer() as Server)
      .post('/__probe/echo')
      .send({ name: 123 })
      .expect(400);

    const body = response.body as ResponseEnvelope<{ fields: FieldErrorDto[] }>;

    expect(body.code).toBe(ErrorCode.PARAM_INVALID);
    expect(body.data.fields[0].field).toBe('name');
  });

  it('不存在的路由返回同构的错误体，而不是框架默认页', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/__probe/does-not-exist')
      .expect(404);

    const body = response.body as ResponseEnvelope<null>;

    expect(body.code).toBe(ErrorCode.NOT_FOUND);
    expect(body.data).toBeNull();
    expect(typeof body.traceId).toBe('string');
  });

  it('未预期异常：响应不泄露细节，完整堆栈只进服务端日志', async () => {
    // 静音控制台的同时留证：完整细节必须进服务端日志、只是不能进响应——
    // 只断言响应不含细节的话，日志侧哪天被删掉也不会有人发现。
    const logSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    const response = await request(app.getHttpServer() as Server)
      .get('/__probe/boom')
      .expect(500);

    const body = response.body as ResponseEnvelope<null>;
    const serialized = JSON.stringify(body);

    expect(body.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(body.message).toBe('服务器内部错误');
    expect(serialized).not.toContain('sentinel-LEAK-CANARY');
    expect(body).not.toHaveProperty('stack');

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('internal detail: sentinel-LEAK-CANARY'),
      expect.stringContaining('internal detail: sentinel-LEAK-CANARY'),
    );
  });

  it('Prisma P2025 映射为资源不存在', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/__probe/prisma-missing')
      .expect(404);

    const body = response.body as ResponseEnvelope<null>;

    expect(body.code).toBe(ErrorCode.NOT_FOUND);
    expect(body.data).toBeNull();
  });

  it('未带业务码的 409 映射到 CONFLICT', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/__probe/conflict')
      .expect(409);

    const body = response.body as ResponseEnvelope<null>;

    expect(body.code).toBe(ErrorCode.CONFLICT);
    expect(body.message).toBe('重复冲突');
  });

  it('@NoEnvelope 路由跳过外壳，返回裸载荷', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/__probe/raw')
      .expect(200);

    expect(response.body).toEqual({ raw: true });
    expect(response.body).not.toHaveProperty('code');
    expect(response.body).not.toHaveProperty('message');
    expect(response.body).not.toHaveProperty('data');
  });
});
