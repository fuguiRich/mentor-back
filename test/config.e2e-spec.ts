import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { ErrorCode } from '../src/common/constants/error-code';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import type {
  ConfigPageResponseDto,
  CreateConfigDto,
} from '../src/modules/config/dto/config.dto';
import type { ConfigResponseDto } from '../src/modules/config/dto/config-response.dto';
import {
  authedAgent,
  clearRedisKeys,
  clearBusinessTables,
  clearModuleTables,
  loginAs,
  seedSuperAdmin,
  type E2eApi,
} from './e2e-helpers';

describe('系统配置 (e2e)', () => {
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

  async function create(
    dto: Partial<CreateConfigDto> & Pick<CreateConfigDto, 'code'>,
  ): Promise<ConfigResponseDto> {
    const response = await api
      .post('/configs')
      .send({ name: '预约有效期', value: '24', valueType: 'number', ...dto })
      .expect(201);
    const body = response.body as ResponseEnvelope<ConfigResponseDto>;
    expect(body.code).toBe(0);
    return body.data;
  }

  it('1. 新建 number 配置 → 201，未传 status 为 1', async () => {
    const created = await create({ code: 'appoint.ttlHours' });
    expect(created).toMatchObject({
      code: 'appoint.ttlHours',
      value: '24',
      valueType: 'number',
      status: 1,
    });
    expect(typeof created.id).toBe('string');
  });

  it('2. 值与声明类型不符 → 400 / 26104', async () => {
    const response = await api
      .post('/configs')
      .send({
        code: 'a.bool',
        name: '开关',
        value: 'yes',
        valueType: 'boolean',
      })
      .expect(400);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.CONFIG_VALUE_MISMATCH);
  });

  it('3. 类型名写错：管道答 10001，库里的脏类型名才轮到 26103', async () => {
    // 两个码要分得开：26103 是「类型名本身非法」，26104 是「值跟类型对不上」。
    // 但 26103 不是 HTTP 上的第一道答——valueType 的取值范围归 class-validator，
    // 直接传 'yaml' 被 @IsIn 拦成 10001（fields 含 valueType）。
    // 26103 的真实入口是**生效类型来自库里**：PUT 不传 valueType 时拿的是当前行
    // 的 valueType，而那一列没有枚举约束（VarChar(20)），历史数据 / 手工改库
    // 都可能塞进一个不存在的类型名——那时再报 10001 就答错了。
    const piped = await api
      .post('/configs')
      .send({ code: 'a.yaml', name: '杂', value: '1', valueType: 'yaml' })
      .expect(400);
    const pipedBody = piped.body as ResponseEnvelope<{
      fields: Array<{ field: string }>;
    }>;
    expect(pipedBody.code).toBe(ErrorCode.PARAM_INVALID);
    expect(pipedBody.data.fields.map((f) => f.field)).toContain('valueType');

    // 对照组：把库里的类型名写脏，再走 update（不传 valueType）→ 26103。
    // 走裸 SQL 而不是 Prisma.update：这条前提就是「列里的脏值不经过应用写入」，
    // 让审计扩展去填 created_by 反而把前提污染了。
    const created = await create({
      code: 'e2e.dirty-type',
      value: '1',
      valueType: 'number',
    });
    await prisma.client.$executeRawUnsafe(
      'UPDATE sys_config SET value_type = ? WHERE id = ?',
      'yaml',
      BigInt(created.id),
    );

    const served = await api
      .put(`/configs/${created.id}`)
      .send({ name: '脏类型名', value: '1' })
      .expect(400);
    expect((served.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.CONFIG_VALUE_TYPE_INVALID,
    );
  });

  it('4. number 只认有限十进制：空串 / 1e3 / Infinity 一律 26104', async () => {
    // Number('') 是 0、Number('1e3') 是 1000、Number('Infinity') 是 Infinity——
    // 交给 Number() 一把梭会把脏值全放进来
    for (const value of ['', '  ', '0x1F', '1e3', 'Infinity', 'NaN']) {
      const response = await api
        .post('/configs')
        .send({
          code: `num.${value.trim() || 'blank'}`,
          name: '数字',
          value,
          valueType: 'number',
        })
        .expect(400);
      expect((response.body as ResponseEnvelope<null>).code).toBe(
        ErrorCode.CONFIG_VALUE_MISMATCH,
      );
    }
  });

  it('5. 编码重复 → 409 / 26102', async () => {
    await create({ code: 'dup.code' });
    const response = await api
      .post('/configs')
      .send({ code: 'dup.code', name: '重复', value: 'x', valueType: 'string' })
      .expect(409);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.CONFIG_CODE_TAKEN,
    );
  });

  it('6. update 不传 valueType → 按**当前**类型校验新值（不是跳过）', async () => {
    // UpdateConfigDto 是 PUT 全量替换：name 与 value 必填，valueType 省略表示保持原值。
    // 这条是这个模块最容易长歪的地方——若拿「请求里的类型」（undefined）去校验，
    // 任何脏值都能溜进来。
    const created = await create({
      code: 'e2e.update.current-type',
      value: 'true',
      valueType: 'boolean',
    });

    const response = await api
      .put(`/configs/${created.id}`)
      .send({ name: '开关', value: 'notabool' })
      .expect(400);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.CONFIG_VALUE_MISMATCH,
    );
  });

  it('7. update 改了 valueType → 新值按**新**类型校验', async () => {
    const created = await create({
      code: 'e2e.update.new-type',
      value: 'abc',
      valueType: 'string',
    });

    const response = await api
      .put(`/configs/${created.id}`)
      .send({
        name: '并发上限',
        value: 'not-a-number',
        valueType: 'number',
      })
      .expect(400);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.CONFIG_VALUE_MISMATCH,
    );

    // 对照组：换成合法的新类型值就该过
    const ok = await api
      .put(`/configs/${created.id}`)
      .send({ name: '并发上限', value: '32', valueType: 'number' })
      .expect(200);
    expect((ok.body as ResponseEnvelope<ConfigResponseDto>).data).toMatchObject(
      {
        value: '32',
        valueType: 'number',
      },
    );
  });

  it('8. json 类型要真能解析；boolean 只认字面量 true / false', async () => {
    const badJson = await api
      .post('/configs')
      .send({ code: 'j.bad', name: '坏 JSON', value: '{', valueType: 'json' })
      .expect(400);
    expect((badJson.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.CONFIG_VALUE_MISMATCH,
    );

    const goodJson = await create({
      code: 'j.ok',
      name: '好 JSON',
      value: '{"a":1}',
      valueType: 'json',
    });
    expect(goodJson.value).toBe('{"a":1}');

    for (const value of ['1', 'TRUE', 'False', 'yes']) {
      const response = await api
        .post('/configs')
        .send({
          code: `b.${value}`,
          name: '布尔',
          value,
          valueType: 'boolean',
        })
        .expect(400);
      expect((response.body as ResponseEnvelope<null>).code).toBe(
        ErrorCode.CONFIG_VALUE_MISMATCH,
      );
    }
  });

  it('9. 详情 404 / 26101；软删后再查同样 404', async () => {
    const missing = await api.get('/configs/999999').expect(404);
    expect((missing.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.CONFIG_NOT_FOUND,
    );

    const created = await create({ code: 'e2e.to-delete' });
    await api.delete(`/configs/${created.id}`).expect(204);

    const gone = await api.get(`/configs/${created.id}`).expect(404);
    expect((gone.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.CONFIG_NOT_FOUND,
    );

    // 软删后编码可以复用（生成列只给未删除行建唯一索引）
    const reused = await create({ code: 'e2e.to-delete' });
    expect(reused.id).not.toBe(created.id);
  });

  it('10. 列表可按 code / name 模糊筛、status 精确筛', async () => {
    await create({
      code: 'e2e.filter.on',
      name: '启用项',
      value: 'a',
      valueType: 'string',
      status: 1,
    });
    await create({
      code: 'e2e.filter.off',
      name: '停用项',
      value: 'b',
      valueType: 'string',
      status: 0,
    });

    const byCode = await api.get('/configs?code=e2e.filter').expect(200);
    const byCodeBody = byCode.body as ResponseEnvelope<ConfigPageResponseDto>;
    expect(byCodeBody.data.total).toBe(2);

    const byStatus = await api
      .get('/configs?code=e2e.filter&status=0')
      .expect(200);
    const byStatusBody =
      byStatus.body as ResponseEnvelope<ConfigPageResponseDto>;
    expect(byStatusBody.data.total).toBe(1);
    expect(byStatusBody.data.list[0].code).toBe('e2e.filter.off');
  });

  it('11. 分页结构是 { list, total, page, pageSize }（RES-06）', async () => {
    const response = await api.get('/configs?page=1&pageSize=1').expect(200);
    const body = response.body as ResponseEnvelope<ConfigPageResponseDto>;
    expect(body.data.list).toHaveLength(1);
    expect(body.data).toMatchObject({ page: 1, pageSize: 1 });
    expect(typeof body.data.total).toBe('number');
  });
});
