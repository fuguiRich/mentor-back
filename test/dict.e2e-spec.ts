import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { ErrorCode } from '../src/common/constants/error-code';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import type {
  DictItemPageResponseDto,
  DictTypePageResponseDto,
} from '../src/modules/dict/dto/dict-page-response.dto';
import type { DictItemResponseDto } from '../src/modules/dict/dto/dict-item-response.dto';
import type { DictTypeResponseDto } from '../src/modules/dict/dto/dict-type-response.dto';
import {
  authedAgent,
  clearRedisKeys,
  clearBusinessTables,
  clearModuleTables,
  loginAs,
  seedSuperAdmin,
  type E2eApi,
} from './e2e-helpers';

describe('数据字典 (e2e)', () => {
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
    // 同 dept.e2e-spec.ts 的两条讲究：清库不能连累关应用，未赋值的守卫要保留真原因
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

  async function createType(
    code: string,
    name = '性别',
  ): Promise<DictTypeResponseDto> {
    const response = await api
      .post('/dict-types')
      .send({ code, name })
      .expect(201);
    const body = response.body as ResponseEnvelope<DictTypeResponseDto>;
    expect(body.code).toBe(0);
    return body.data;
  }

  async function createItem(
    dictTypeId: string,
    label: string,
    value: string,
  ): Promise<DictItemResponseDto> {
    const response = await api
      .post('/dict-items')
      .send({ dictTypeId, label, value })
      .expect(201);
    const body = response.body as ResponseEnvelope<DictItemResponseDto>;
    expect(body.code).toBe(0);
    return body.data;
  }

  // ── 字典类型 ─────────────────────────────────────────────────────

  it('1. 新建字典类型 → 201，未传 status 时为 1，id 是字符串', async () => {
    const created = await createType('gender', '性别');

    expect(created).toMatchObject({
      code: 'gender',
      name: '性别',
      status: 1,
    });
    expect(typeof created.id).toBe('string');
    expect(created.id).toMatch(/^\d+$/);
    expect(created.remark).toBeNull();
  });

  it('2. 编码重复 → 409 / 25102', async () => {
    const response = await api
      .post('/dict-types')
      .send({ code: 'gender', name: '性别二' })
      .expect(409);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.DICT_TYPE_CODE_TAKEN);
    expect(body.data).toBeNull();
  });

  it('3. 编码不合正则 → 400 / 10001，data.fields 逐字段给出', async () => {
    // 编码是前端当 key 用的：大写、中文、空串都会在别的地方炸
    for (const code of ['Gender', '性别', '1gender', '']) {
      const response = await api
        .post('/dict-types')
        .send({ code, name: '非法编码' })
        .expect(400);
      const body = response.body as ResponseEnvelope<{
        fields: Array<{ field: string }>;
      }>;
      expect(body.code).toBe(ErrorCode.PARAM_INVALID);
      expect(body.data.fields.map((f) => f.field)).toContain('code');
    }
  });

  it('4. 详情：不存在 → 404 / 25101；存在 → 回填完整字段', async () => {
    const missing = await api.get('/dict-types/999999').expect(404);
    const missingBody = missing.body as ResponseEnvelope<null>;
    expect(missingBody.code).toBe(ErrorCode.DICT_TYPE_NOT_FOUND);

    const created = await createType('grade', '年级');
    const found = await api.get(`/dict-types/${created.id}`).expect(200);
    const foundBody = found.body as ResponseEnvelope<DictTypeResponseDto>;
    expect(foundBody.data).toMatchObject({ id: created.id, code: 'grade' });
  });

  // ── 字典项 ──────────────────────────────────────────────────────

  it('5. 字典项所属类型不存在 → 404 / 25101，且**不查重不写库**', async () => {
    const response = await api
      .post('/dict-items')
      .send({ dictTypeId: '999999', label: '男', value: 'M' })
      .expect(404);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.DICT_TYPE_NOT_FOUND);

    const list = await api.get('/dict-items?dictTypeId=999999').expect(200);
    const listBody = list.body as ResponseEnvelope<DictItemPageResponseDto>;
    expect(listBody.data.total).toBe(0);
  });

  it('6. value 唯一是**按类型**限定的：同值进另一类型可以，同类型重复 409 / 25105', async () => {
    const gender = await createType('sex_type_a', '性别甲');
    const other = await createType('sex_type_b', '性别乙');

    await createItem(gender.id, '男', 'M');
    // 换个类型，同样的 value —— 这一条就是「不是全局唯一」的判据
    await createItem(other.id, '男', 'M');

    const dup = await api
      .post('/dict-items')
      .send({ dictTypeId: gender.id, label: '男性', value: 'M' })
      .expect(409);
    const body = dup.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.DICT_ITEM_VALUE_TAKEN);
  });

  it('7. 删类型时底下还有项 → 409 / 25103，且类型**没有**被删掉', async () => {
    // 判序是这条的判据：先删再判会出现「删不掉」和「已经删了」同时成立
    const type = await createType('has_items', '带项类型');
    await createItem(type.id, '甲', 'A');

    const response = await api.delete(`/dict-types/${type.id}`).expect(409);
    const body = response.body as ResponseEnvelope<null>;
    expect(body.code).toBe(ErrorCode.DICT_TYPE_HAS_ITEMS);

    const still = await api.get(`/dict-types/${type.id}`).expect(200);
    expect((still.body as ResponseEnvelope<DictTypeResponseDto>).data.id).toBe(
      type.id,
    );
  });

  it('8. 项删光后类型可删 → 204，再查 404 / 25101', async () => {
    const type = await createType('empty_type', '空类型');
    const item = await createItem(type.id, '甲', 'A');

    await api.delete(`/dict-items/${item.id}`).expect(204);
    await api.delete(`/dict-types/${type.id}`).expect(204);

    const gone = await api.get(`/dict-types/${type.id}`).expect(404);
    expect((gone.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.DICT_TYPE_NOT_FOUND,
    );
  });

  it('9. 改项只改 label（不传 value）→ 不做重名检查', async () => {
    // 反过来（一律查重）会把自己当成自己的重名，任何「只改显示名」都会失败
    const type = await createType('label_only', '只改文案');
    const item = await createItem(type.id, '男', 'M');

    const response = await api
      .put(`/dict-items/${item.id}`)
      .send({ label: '男性' })
      .expect(200);
    const body = response.body as ResponseEnvelope<DictItemResponseDto>;
    expect(body.data).toMatchObject({ label: '男性', value: 'M' });
  });

  it('10. 改项换了 value 且撞车 → 409 / 25105', async () => {
    const type = await createType('rename_value', '改值撞车');
    const kept = await createItem(type.id, '男', 'M');
    const target = await createItem(type.id, '女', 'F');

    const response = await api
      .put(`/dict-items/${target.id}`)
      .send({ label: '男性', value: 'M' })
      .expect(409);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.DICT_ITEM_VALUE_TAKEN,
    );

    // 撞车没写进去
    const unchanged = await api.get('/dict-items').query({
      dictTypeId: type.id,
    });
    const rows = (unchanged.body as ResponseEnvelope<DictItemPageResponseDto>)
      .data.list;
    expect(rows.find((r) => r.id === target.id)?.value).toBe('F');
    expect(kept.value).toBe('M');
  });

  it('11. 所属类型不可改：PUT 带 dictTypeId 被管道拒（白名单多传）', async () => {
    const a = await createType('move_from', '搬家源');
    const b = await createType('move_to', '搬家目标');
    const item = await createItem(a.id, '甲', 'A');

    const response = await api
      .put(`/dict-items/${item.id}`)
      .send({ label: '甲', dictTypeId: b.id })
      .expect(400);
    const body = response.body as ResponseEnvelope<{
      fields: Array<{ field: string }>;
    }>;
    expect(body.code).toBe(ErrorCode.PARAM_INVALID);
  });

  // ── 列表与筛选 ───────────────────────────────────────────────────

  it('12. 按 dictTypeCode 过滤；不存在的编码回空列表而不是 404', async () => {
    const type = await createType('fruit', '水果');
    await createItem(type.id, '苹果', 'apple');
    await createItem(type.id, '香蕉', 'banana');

    const hit = await api.get('/dict-items?dictTypeCode=fruit').expect(200);
    const hitBody = hit.body as ResponseEnvelope<DictItemPageResponseDto>;
    expect(hitBody.data.total).toBe(2);

    const miss = await api.get('/dict-items?dictTypeCode=no_such').expect(200);
    const missBody = miss.body as ResponseEnvelope<DictItemPageResponseDto>;
    expect(missBody.data).toMatchObject({ list: [], total: 0 });
  });

  it('13. 同类型内按 sortOrder 升序、id 升序', async () => {
    const type = await createType('ordered', '排序');
    // 刻意后建「一」：sortOrder 小的必须排在前面，不能靠插入顺序蒙混
    await api
      .post('/dict-items')
      .send({ dictTypeId: type.id, label: '三', value: 'c', sortOrder: 3 })
      .expect(201);
    await api
      .post('/dict-items')
      .send({ dictTypeId: type.id, label: '一', value: 'a', sortOrder: 1 })
      .expect(201);

    const response = await api
      .get('/dict-items')
      .query({ dictTypeId: type.id })
      .expect(200);
    const body = response.body as ResponseEnvelope<DictItemPageResponseDto>;
    expect(body.data.list.map((r) => r.label)).toEqual(['一', '三']);
  });

  it('14. 字典类型列表可按 code / name 模糊筛', async () => {
    const response = await api.get('/dict-types?code=gen').expect(200);
    const body = response.body as ResponseEnvelope<DictTypePageResponseDto>;
    expect(body.data.total).toBeGreaterThanOrEqual(1);
    for (const row of body.data.list) {
      expect(row.code).toContain('gen');
    }
  });
});
