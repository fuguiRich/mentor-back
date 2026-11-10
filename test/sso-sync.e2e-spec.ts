import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import type { AppConfig } from '../src/config/configuration';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { runWithSyncWrite } from '../src/infra/prisma/sync-write-scope';
import { RedisService } from '../src/infra/redis/redis.service';
import { SsoOpenApiClient } from '../src/modules/sync/sso/sso-open-api.client';
import { SsoSyncSource } from '../src/modules/sync/sso/sso-sync.source';
import { SyncRunRepository } from '../src/modules/sync/sync-run.repository';
import { SyncService } from '../src/modules/sync/sync.service';
import { SyncRunStatus } from '../src/modules/sync/sync.constants';
import { clearBusinessTables, clearRedisKeys } from './e2e-helpers';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(handler: (url: URL) => Response): typeof fetch {
  return (input: string | URL | Request) => {
    const raw =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return handler(new URL(raw));
  };
}

const ORG_TREE = [
  {
    deptId: '1',
    parentId: '0',
    deptName: '长沙医学院',
    children: [
      {
        deptId: '10',
        parentId: '1',
        deptName: '计算机学院',
        children: [],
      },
    ],
  },
];

const CLASSES = [
  {
    class_name: '软工2301',
    college_name: '计算机学院',
    major_name: '软件工程',
  },
];

async function clearSyncTables(prisma: PrismaService): Promise<void> {
  const tables = ['mentor_profile', 'sync_person', 'sync_org_unit', 'sync_run'];
  for (const table of tables) {
    await prisma.client.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
}

describe('SSO 定时同步 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let sync: SyncService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    sync = app.get(SyncService);
  });

  afterAll(async () => {
    try {
      if (prisma !== undefined) {
        await clearBusinessTables(prisma);
        await clearSyncTables(prisma);
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

  async function reset(): Promise<void> {
    await clearBusinessTables(prisma);
    await clearSyncTables(prisma);
    await clearRedisKeys(redis);

    await prisma.client.sysDept.create({
      data: {
        parentId: null,
        name: '总公司',
        sortOrder: 0,
        status: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    await prisma.client.sysRole.createMany({
      data: [
        {
          code: 'mentor',
          name: '导师',
          dataScope: 'self',
          status: 1,
          createdBy: 0n,
          updatedBy: 0n,
        },
        {
          code: 'student',
          name: '学生',
          dataScope: 'self',
          status: 1,
          createdBy: 0n,
          updatedBy: 0n,
        },
        {
          code: 'teacher',
          name: '教师',
          dataScope: 'self',
          status: 1,
          createdBy: 0n,
          updatedBy: 0n,
        },
      ],
    });
  }

  function makeSource(fetchImpl: typeof fetch): SsoSyncSource {
    const values: Record<string, unknown> = {
      'sso.baseUrl': 'https://sso.test',
      'sso.openApiPrefix': '/api',
      'sso.appId': 'app_x',
      'sso.appSecret': 'secret',
      'sso.syncPageSize': 200,
      'sso.apiLoginTimeoutMs': 1000,
      'sso.openApiTimeoutMs': 1000,
      'sso.caCertPath': '',
      'sso.syncStudentsEnabled': true,
    };
    const config = {
      get: (key: string) => values[key],
      getOrThrow: (key: string) => values[key],
    } as unknown as ConfigService<AppConfig, true>;
    return new SsoSyncSource(new SsoOpenApiClient(config, fetchImpl), config);
  }

  function defaultFetch(): typeof fetch {
    return fakeFetch((url) => {
      if (url.pathname.endsWith('/auth/token')) {
        return json({ code: 200, token: 't', expiresIn: 300 });
      }
      if (url.pathname.endsWith('/open/org/departments')) {
        return json({ code: 200, total: 1, items: ORG_TREE });
      }
      if (url.pathname.endsWith('/open/edu/classes')) {
        return json({ code: 200, total: 1, items: CLASSES });
      }
      if (url.pathname.endsWith('/data/teachers')) {
        return json({
          code: 200,
          total: 1,
          page: 1,
          pageSize: 200,
          totalPages: 1,
          items: [{ workId: 'T1', name: '张三', organization: '计算机学院' }],
        });
      }
      if (url.pathname.endsWith('/data/students')) {
        return json({
          code: 200,
          total: 1,
          page: 1,
          pageSize: 200,
          totalPages: 1,
          items: [{ studentId: 'S1', name: '李四', organization: '软工2301' }],
        });
      }
      return json({ code: 404, msg: 'not found' }, 404);
    });
  }

  it('全量同步：组织/教师/学生落库，根部门复用，同级同名部门复用', async () => {
    await reset();

    // 本地已有一个同级同名部门：同步应复用它，而不是撞唯一键失败
    const root = await prisma.client.sysDept.findFirst({
      where: { parentId: null },
    });
    const localCollege = await prisma.client.sysDept.create({
      data: {
        parentId: root?.id ?? null,
        name: '计算机学院',
        sortOrder: 0,
        status: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });

    const result = await sync.runOnce(makeSource(defaultFetch()), {
      mode: 'full',
    });

    expect(result.mode).toBe('full');
    expect(result.status).toBe(SyncRunStatus.OK);

    const units = await prisma.client.syncOrgUnit.findMany({
      orderBy: { code: 'asc' },
    });
    expect(units.map((u) => u.code)).toEqual(['sso:1', 'sso:10']);

    const roots = await prisma.client.sysDept.findMany({
      where: { parentId: null },
    });
    expect(roots).toHaveLength(1);
    expect(roots[0].name).toBe('长沙医学院');
    const college = await prisma.client.sysDept.findFirst({
      where: { name: '计算机学院' },
    });
    expect(college?.id).toBe(localCollege.id);
    expect(college?.parentId).toBe(roots[0].id);
    expect(
      await prisma.client.sysDept.count({ where: { name: '计算机学院' } }),
    ).toBe(1);

    const teacher = await prisma.client.sysUser.findFirst({
      where: { username: 'T1' },
    });
    expect(teacher).toMatchObject({ authSource: 'sso', status: 1 });
    expect(
      (await prisma.client.syncPerson.findFirst({ where: { login: 'T1' } }))
        ?.personType,
    ).toBe('teacher');

    const student = await prisma.client.sysUser.findFirst({
      where: { username: 'S1' },
    });
    expect(student).toMatchObject({ authSource: 'sso', status: 1 });
    expect(
      (await prisma.client.syncPerson.findFirst({ where: { login: 'S1' } }))
        ?.personType,
    ).toBe('student');

    const teacherRole = await prisma.client.sysRole.findFirst({
      where: { code: 'teacher' },
    });
    expect(
      await prisma.client.sysUserRole.findFirst({
        where: { userId: teacher?.id, roleId: teacherRole?.id },
      }),
    ).not.toBeNull();
  });

  it('离场范围：只停 SSO 的 teacher/student，不碰外校导师和 mock 组织', async () => {
    await reset();

    await sync.runOnce(makeSource(defaultFetch()), { mode: 'full' });

    const rootUnit = await prisma.client.syncOrgUnit.findFirst({
      where: { code: 'sso:1' },
    });
    const collegeUnit = await prisma.client.syncOrgUnit.findFirst({
      where: { code: 'sso:10' },
    });
    if (rootUnit === null || collegeUnit === null) {
      throw new Error('第一次同步没有落出 sso 组织');
    }

    // mock 组织挂在 sso 根下面：离场必须按 code 前缀跳过它
    const mockOrg = await runWithSyncWrite(() =>
      prisma.client.syncOrgUnit.create({
        data: {
          code: 'HQ',
          name: 'mock 总部',
          parentId: rootUnit.id,
          kind: 'root',
          syncedAt: new Date(),
          syncRunId: null,
          createdBy: 0n,
          updatedBy: 0n,
        },
      }),
    );

    // 外校导师：authSource=local + personType=externalMentor
    const external = await prisma.client.sysUser.create({
      data: {
        username: 'EXT1',
        password: 'x',
        realName: '外校导师',
        employeeNo: 'EXT1',
        deptId: (
          await prisma.client.sysDept.findFirstOrThrow({
            where: { name: '计算机学院' },
          })
        ).id,
        status: 1,
        isSuperAdmin: false,
        authSource: 'local',
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    await runWithSyncWrite(() =>
      prisma.client.syncPerson.create({
        data: {
          login: 'EXT1',
          realName: '外校导师',
          personType: 'externalMentor',
          orgUnitId: collegeUnit.id,
          syncedAt: new Date(),
          syncRunId: null,
          createdBy: 0n,
          updatedBy: 0n,
        },
      }),
    );

    const emptyFetch = fakeFetch((url) => {
      if (url.pathname.endsWith('/auth/token')) {
        return json({ code: 200, token: 't', expiresIn: 300 });
      }
      if (url.pathname.endsWith('/open/org/departments')) {
        return json({ code: 200, total: 0, items: [] });
      }
      if (url.pathname.endsWith('/open/edu/classes')) {
        return json({ code: 200, total: 0, items: [] });
      }
      if (
        url.pathname.endsWith('/data/teachers') ||
        url.pathname.endsWith('/data/students')
      ) {
        return json({
          code: 200,
          total: 0,
          page: 1,
          pageSize: 200,
          totalPages: 0,
          items: [],
        });
      }
      return json({ code: 404, msg: 'not found' }, 404);
    });

    const result = await sync.runOnce(makeSource(emptyFetch), { mode: 'full' });
    expect(result.status).toBe(SyncRunStatus.OK);

    expect(
      (await prisma.client.sysUser.findFirst({ where: { username: 'EXT1' } }))
        ?.status,
    ).toBe(1);
    expect(
      (await prisma.client.syncOrgUnit.findFirst({ where: { code: 'HQ' } }))
        ?.deletedAt,
    ).toBeNull();
    expect(
      (await prisma.client.syncOrgUnit.findFirst({ where: { code: 'sso:10' } }))
        ?.deletedAt,
    ).not.toBeNull();
    expect(
      (await prisma.client.sysUser.findFirst({ where: { username: 'T1' } }))
        ?.status,
    ).toBe(0);
    expect(
      (await prisma.client.sysDept.findFirst({ where: { parentId: null } }))
        ?.deletedAt,
    ).toBeNull();

    // mockOrg 变量只是为了确保行存在；避免 lint 未使用
    expect(mockOrg.code).toBe('HQ');
    expect(external.authSource).toBe('local');
  });

  it('分页失败：整批 FAILED，已同步的账号不被停用', async () => {
    await reset();

    await sync.runOnce(makeSource(defaultFetch()), { mode: 'full' });

    let teacherPage = 0;
    const brokenFetch = fakeFetch((url) => {
      if (url.pathname.endsWith('/auth/token')) {
        return json({ code: 200, token: 't', expiresIn: 300 });
      }
      if (url.pathname.endsWith('/open/org/departments')) {
        return json({ code: 200, total: 1, items: ORG_TREE });
      }
      if (url.pathname.endsWith('/open/edu/classes')) {
        return json({ code: 200, total: 1, items: CLASSES });
      }
      if (url.pathname.endsWith('/data/teachers')) {
        teacherPage += 1;
        if (teacherPage >= 2) {
          return json({ code: 500, msg: '上游炸了' }, 500);
        }
        return json({
          code: 200,
          total: 2,
          page: 1,
          pageSize: 200,
          totalPages: 2,
          items: [{ workId: 'T2', name: '新教师', organization: '计算机学院' }],
        });
      }
      if (url.pathname.endsWith('/data/students')) {
        return json({
          code: 200,
          total: 0,
          page: 1,
          pageSize: 200,
          totalPages: 0,
          items: [],
        });
      }
      return json({ code: 404, msg: 'not found' }, 404);
    });

    const result = await sync.runOnce(makeSource(brokenFetch), {
      mode: 'full',
    });

    expect(result.status).toBe(SyncRunStatus.FAILED);
    expect(
      (await prisma.client.sysUser.findFirst({ where: { username: 'T1' } }))
        ?.status,
    ).toBe(1);
    expect(
      await prisma.client.sysUser.findFirst({ where: { username: 'T2' } }),
    ).toBeNull();
  });

  it('增量：第二次同步的请求带 updateTime（毫秒）', async () => {
    await reset();

    await sync.runOnce(makeSource(defaultFetch()), { mode: 'full' });

    const seen: Array<string | null> = [];
    const incrementalFetch = fakeFetch((url) => {
      if (url.pathname.endsWith('/auth/token')) {
        return json({ code: 200, token: 't', expiresIn: 300 });
      }
      if (url.pathname.endsWith('/open/org/departments')) {
        return json({ code: 200, total: 1, items: ORG_TREE });
      }
      if (url.pathname.endsWith('/open/edu/classes')) {
        return json({ code: 200, total: 1, items: CLASSES });
      }
      if (url.pathname.endsWith('/data/teachers')) {
        seen.push(url.searchParams.get('updateTime'));
        return json({
          code: 200,
          total: 0,
          page: 1,
          pageSize: 200,
          totalPages: 0,
          items: [],
        });
      }
      if (url.pathname.endsWith('/data/students')) {
        return json({
          code: 200,
          total: 0,
          page: 1,
          pageSize: 200,
          totalPages: 0,
          items: [],
        });
      }
      return json({ code: 404, msg: 'not found' }, 404);
    });

    const result = await sync.runOnce(makeSource(incrementalFetch));
    expect(result.mode).toBe('incremental');
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBeNull();
    expect(Number.isInteger(Number(seen[0]))).toBe(true);
  });
  it('PARTIAL 全量也算完成的全量，调度器不会每次退全量', async () => {
    await reset();

    const partialFetch = fakeFetch((url) => {
      if (url.pathname.endsWith('/auth/token')) {
        return json({ code: 200, token: 't', expiresIn: 300 });
      }
      if (url.pathname.endsWith('/open/org/departments')) {
        return json({ code: 200, total: 1, items: ORG_TREE });
      }
      if (url.pathname.endsWith('/open/edu/classes')) {
        return json({ code: 200, total: 1, items: CLASSES });
      }
      if (url.pathname.endsWith('/data/teachers')) {
        return json({
          code: 200,
          total: 1,
          page: 1,
          pageSize: 200,
          totalPages: 1,
          items: [
            { workId: 'T9', name: '无部门教师', organization: '不存在学院' },
          ],
        });
      }
      if (url.pathname.endsWith('/data/students')) {
        return json({
          code: 200,
          total: 0,
          page: 1,
          pageSize: 200,
          totalPages: 0,
          items: [],
        });
      }
      return json({ code: 404, msg: 'not found' }, 404);
    });

    const result = await sync.runOnce(makeSource(partialFetch), {
      mode: 'full',
    });
    expect(result.status).toBe(SyncRunStatus.PARTIAL);

    const runs = app.get(SyncRunRepository);
    expect(await runs.findLastFinishedByMode('sso', 'full')).not.toBeNull();
  });
  it('本地同名部门已被别的同步行占用 → 复用同一部门，不加（sso:xx）后缀', async () => {
    await reset();

    const root = await prisma.client.sysDept.findFirst({
      where: { parentId: null },
    });
    const localCollege = await prisma.client.sysDept.create({
      data: {
        parentId: root?.id ?? null,
        name: '计算机学院',
        sortOrder: 0,
        status: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    await runWithSyncWrite(() =>
      prisma.client.syncOrgUnit.create({
        data: {
          code: 'DEMO-CS',
          name: '计算机学院',
          parentId: null,
          kind: 'college',
          syncedAt: new Date(),
          syncRunId: null,
          deptId: localCollege.id,
          createdBy: 0n,
          updatedBy: 0n,
        },
      }),
    );

    const first = await sync.runOnce(makeSource(defaultFetch()), {
      mode: 'full',
    });
    expect(first.status).toBe(SyncRunStatus.OK);

    // 不再造带后缀的副本：sso:10 直接复用本地同名部门
    const ssoUnit = await prisma.client.syncOrgUnit.findFirst({
      where: { code: 'sso:10', deletedAt: null },
    });
    expect(ssoUnit?.deptId).toBe(localCollege.id);
    const sameName = await prisma.client.sysDept.findMany({
      where: {
        parentId: root?.id ?? null,
        name: '计算机学院',
        deletedAt: null,
      },
    });
    expect(sameName).toHaveLength(1);

    const second = await sync.runOnce(makeSource(defaultFetch()), {
      mode: 'full',
    });
    expect(second.status).toBe(SyncRunStatus.OK);
    expect(
      (
        await prisma.client.sysDept.findFirst({
          where: { id: localCollege.id },
        })
      )?.name,
    ).toBe('计算机学院');
  });
});
