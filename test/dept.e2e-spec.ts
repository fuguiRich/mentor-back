import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { ErrorCode } from '../src/common/constants/error-code';
import type { FieldErrorDto } from '../src/common/dto/field-error.dto';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import type { DeptResponseDto } from '../src/modules/dept/dto/dept-response.dto';
import type { DeptTreeResponseDto } from '../src/modules/dept/dto/dept-tree-response.dto';
import {
  authedAgent,
  clearRedisKeys,
  clearBusinessTables,
  loginAs,
  seedSuperAdmin,
  type E2eApi,
} from './e2e-helpers';

describe('部门查询 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let api: E2eApi;
  let rootId: string;
  let childId: string;

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
    await clearRedisKeys(redis);

    const admin = await seedSuperAdmin(prisma);
    const tokens = await loginAs(app, admin.username, admin.password);
    api = authedAgent(app, tokens.accessToken);

    // seedSuperAdmin 已经种了「总公司」部门，这里找到它当 root，不再重复创建。
    const root = await prisma.client.sysDept.findFirst({
      where: { name: '总公司' },
    });
    if (root === null) {
      throw new Error('seedSuperAdmin 未种出「总公司」部门');
    }
    // 6b 收口后没有建部门的 HTTP 入口——组织行的形状就是同步投影（6a）写的
    // 这个形状，测试用 Prisma 直插照着建。
    const child = await prisma.client.sysDept.create({
      data: {
        parentId: root.id,
        name: '信息中心',
        sortOrder: 1,
        status: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });

    rootId = root.id.toString();
    childId = child.id.toString();
  });

  afterAll(async () => {
    // 本套件跑完后把六张表清空（顺序与 beforeAll 相同）。
    // beforeAll 只保证「本套件下次跑」有个干净起点；这段额外保证
    // 「跑在本套件之后的其他测试」同样从空库开始——残行不仅占用外键，
    // 还会推高自增计数器，让后续对 id 的断言悄悄偏掉。
    //
    // 两个 undefined 守卫是刻意的：若 beforeAll 在赋值之前就失败（例如
    // app.init() 抛错），afterAll 照跑——那时要保留原始的失败原因，
    // 不能在这里抛个二次错误把它顶掉。
    //
    // try/finally 与那段守卫同源、管的是另一条路径：清库抛错同样不能连累
    // 关闭应用——否则 Nest 应用和它的 Prisma 连接池一直挂着，jest 的症状
    // 是「跑完不退出」，而不是这条真原因「清库失败」，排查很绕。
    try {
      if (prisma !== undefined) {
        await clearBusinessTables(prisma);
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

  it('GET /depts/tree 返回树形结构', async () => {
    const response = await api.get('/depts/tree').expect(200);

    const body = response.body as ResponseEnvelope<DeptTreeResponseDto[]>;

    expect(body.code).toBe(0);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: rootId,
      name: '总公司',
      parentId: null,
    });
    expect(body.data[0].children).toHaveLength(1);
    expect(body.data[0].children[0]).toMatchObject({
      id: childId,
      name: '信息中心',
    });
  });

  it('树节点带齐审计字段，且同步投影建的行创建人为系统标识 0', async () => {
    const response = await api.get('/depts/tree');

    const body = response.body as ResponseEnvelope<DeptTreeResponseDto[]>;

    expect(body.data[0].createdBy).toBe('0');
    expect(body.data[0].createdAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('GET /depts/:id 返回详情', async () => {
    const response = await api.get(`/depts/${childId}`).expect(200);

    const body = response.body as ResponseEnvelope<DeptResponseDto>;

    expect(body.data).toMatchObject({
      id: childId,
      name: '信息中心',
      parentId: rootId,
      status: 1,
    });
  });

  it('ID 不是数字时返回参数校验失败，且指出字段名', async () => {
    const response = await api.get('/depts/abc').expect(400);

    const body = response.body as ResponseEnvelope<{ fields: FieldErrorDto[] }>;

    expect(body.code).toBe(ErrorCode.PARAM_INVALID);
    expect(body.data.fields[0].field).toBe('id');
  });

  // 四条边界都必须停在 400，不能漏到 controller 里变成 500：
  // 小数/负号会让 `BigInt('1.5')` 直接抛 SyntaxError；超过 2^63-1 的数字
  // 在 JS 里能算出 BigInt，但 Prisma 按**有符号** 64 位绑定参数，查询时报错。
  // 校验器是唯一的闸门，这里逐条钉住。
  it.each(['-1', '1.5', '9223372036854775808', '18446744073709551615'])(
    'GET /depts/%s 返回 400 参数校验失败（而不是 500）',
    async (rawId) => {
      const response = await api.get(`/depts/${rawId}`).expect(400);

      const body = response.body as ResponseEnvelope<{
        fields: FieldErrorDto[];
      }>;

      expect(body.code).toBe(ErrorCode.PARAM_INVALID);
      expect(body.data.fields[0].field).toBe('id');
    },
  );

  it('部门不存在时返回 404 与部门模块的错误码', async () => {
    const response = await api.get('/depts/999999').expect(404);

    const body = response.body as ResponseEnvelope<null>;

    expect(body.code).toBe(ErrorCode.DEPT_NOT_FOUND);
    expect(body.message).toBe('部门不存在');
  });

  // ?name= 的语义：筛选的是「扁平集合」，命中的节点若其父不在结果集里，
  // 会被提升为根节点返回，而不是从结果里凭空消失。三条把它钉死在 HTTP 层。
  it('GET /depts/tree?name=信息：父不在结果集里时，命中节点提升为根', async () => {
    const response = await api
      .get('/depts/tree')
      .query({ name: '信息' })
      .expect(200);

    const body = response.body as ResponseEnvelope<DeptTreeResponseDto[]>;

    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: childId,
      name: '信息中心',
      parentId: rootId,
    });
    expect(body.data[0].children).toHaveLength(0);
  });

  it('GET /depts/tree?name=总：命中根节点', async () => {
    const response = await api
      .get('/depts/tree')
      .query({ name: '总' })
      .expect(200);

    const body = response.body as ResponseEnvelope<DeptTreeResponseDto[]>;

    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: rootId,
      name: '总公司',
      parentId: null,
    });
    expect(body.data[0].children).toHaveLength(0);
  });

  it('GET /depts/tree?name=不存在的部门：返回空数组', async () => {
    const response = await api
      .get('/depts/tree')
      .query({ name: '不存在的部门' })
      .expect(200);

    const body = response.body as ResponseEnvelope<DeptTreeResponseDto[]>;

    expect(body.data).toEqual([]);
  });

  it('软删除的部门不出现在树里，也查不到详情', async () => {
    // R24：扩展不再把 delete 改写成软删除（会逃出事务），软删除是显式 update——
    // 与 DeptRepository.softDelete 同形状（deletedAt/deletedBy 由调用方写）。
    await prisma.client.sysDept.update({
      where: { id: BigInt(childId) },
      data: { deletedAt: new Date(), deletedBy: 0n },
    });

    const tree = await api.get('/depts/tree');
    const treeBody = tree.body as ResponseEnvelope<DeptTreeResponseDto[]>;
    expect(treeBody.data[0].children).toHaveLength(0);

    const detail = await api.get(`/depts/${childId}`);
    expect(detail.status).toBe(404);
  });

  it('软删除是 UPDATE 而不是物理删除——行还在，只是带上了 deleted_at', async () => {
    const row = await prisma.includingDeleted.sysDept.findFirst({
      where: { id: BigInt(childId) },
    });

    expect(row).not.toBeNull();
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(row?.deletedBy).toBe(0n);

    // 这两条守的是「软删除这一次写入过了扩展的 update 审计填充」：
    // updated_at / updated_by 必须被刷成软删除当次的值，而不是停在上一次业务更新。
    // R24 之后 deleted_at 由调用方的显式 update 写（repository 的 softDelete 形状），
    // updated_* 由扩展在同一条 UPDATE 里补上——两次取时钟几乎同刻但不保证相等，
    // 所以断言「不早于」而不是「严格相等」。漏了审计填充（或绕过扩展裸写）时
    // updated_at 会停在上一次业务更新、比 deleted_at 早——不报错、接口全绿，
    // 只有事后翻数据才看得出来。
    // 非空由上面的断言负责；`!` 只为过 strictNullChecks——
    // 若真为 null，.getTime() 会当场抛 TypeError，这条断言不会被悄悄放过。
    expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(
      row!.deletedAt!.getTime(),
    );
    expect(row?.updatedBy).toBe(0n);
  });

  it('软删除后同名部门可以重建（DB-11 生成列唯一索引生效）', async () => {
    // 重建也走 Prisma 直插（6b 收口后没有 POST /depts），形状与同步投影一致。
    const nakedData = {
      parentId: BigInt(rootId),
      name: '信息中心',
      sortOrder: 1,
      status: 1,
      createdBy: 0n,
      updatedBy: 0n,
    };

    const recreated = await prisma.client.sysDept.create({ data: nakedData });
    expect(recreated.name).toBe('信息中心');

    // 只断言「软删除后能重建」不足以证明索引存在：唯一索引**根本没建**时，
    // 这一步同样会成功、断言照样绿。判据必须是一对——下面第一条证明索引在，
    // 第二条证明它认生成列（把已删除的行排除在外）。
    // 判据一：同层同名的活跃行已在库里，再裸插必须失败于 P2002。
    const duplicateInsert = prisma.client.sysDept.create({ data: nakedData });
    await expect(duplicateInsert).rejects.toMatchObject({ code: 'P2002' });

    // 判据二：把上面那行（唯一占着名字的活跃行）软删除后，同样的裸插必须成功——
    // 证明唯一性来自生成列（name_active 在 deleted_at 非空时为 NULL），
    // 而不是普通唯一键：后者下这条老名字会一直占位、插入会继续失败。
    // R24：软删除是显式 update，扩展对实体表的 delete 直接拒绝
    await prisma.client.sysDept.update({
      where: { id: recreated.id },
      data: { deletedAt: new Date(), deletedBy: 0n },
    });

    const inserted = await prisma.client.sysDept.create({ data: nakedData });
    expect(inserted.name).toBe('信息中心');
  });

  it('连接表是物理删除（DB-10）', async () => {
    const dept = await prisma.includingDeleted.sysDept.findFirst({
      where: { name: '总公司' },
    });
    const user = await prisma.client.sysUser.create({
      data: {
        username: '__tmp_user',
        password: 'x',
        realName: '临时',
        employeeNo: '__tmp_user',
        deptId: dept?.id ?? 0n,
        status: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    const role = await prisma.client.sysRole.create({
      data: {
        name: '__tmp_role',
        code: '__tmp_role',
        status: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    const link = await prisma.client.sysUserRole.create({
      data: { userId: user.id, roleId: role.id, createdBy: 0n, updatedBy: 0n },
    });

    await prisma.client.sysUserRole.delete({ where: { id: link.id } });

    const gone = await prisma.client.sysUserRole.findFirst({
      where: { id: link.id },
    });
    expect(gone).toBeNull();

    // 清理。用 includingDeleted 走物理删除——留两行软删的残骸在这里，
    // 下次 e2e 的 beforeAll 才不用去对付它们。
    await prisma.includingDeleted.sysUser.delete({ where: { id: user.id } });
    await prisma.includingDeleted.sysRole.delete({ where: { id: role.id } });
  });

  // ── 判据 1（depts 部分）：收口后三条写路由全部 404 ─────────────────────
  // SysDept 只能由同步投影产生（6a 的 ProjectionWriter）。路由没了，
  // RequirePermission 那层也就没了——对超管也是 404，不是 403 / 405 / 200。
  describe('收口后的写入口（判据 1）', () => {
    it('POST /depts → 404，部门不被创建', async () => {
      await api
        .post('/depts')
        .send({ parentId: null, name: '不该建出来' })
        .expect(404);

      const row = await prisma.client.sysDept.findFirst({
        where: { name: '不该建出来' },
      });
      expect(row).toBeNull();
    });

    it('PUT /depts/:id → 404，名称不被改动', async () => {
      await api
        .put(`/depts/${rootId}`)
        .send({ name: '改了名的总部' })
        .expect(404);

      const row = await prisma.client.sysDept.findFirst({
        where: { name: '总公司' },
      });
      expect(row).not.toBeNull();
    });

    it('DELETE /depts/:id → 404，行还在（不是软删，更不是物理删）', async () => {
      await api.delete(`/depts/${rootId}`).expect(404);

      const row = await prisma.client.sysDept.findFirst({
        where: { name: '总公司' },
      });
      expect(row).not.toBeNull();
    });
  });
});
