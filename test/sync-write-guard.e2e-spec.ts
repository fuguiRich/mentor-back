import { HttpStatus, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ErrorCode } from '../src/common/constants/error-code';
import { BusinessException } from '../src/common/errors/business.exception';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import {
  isSyncWriteScope,
  runWithSyncWrite,
} from '../src/infra/prisma/sync-write-scope';

/**
 * 同步层写入守卫（prisma.extension.ts 的 SYNC_OWNED_MODELS）。
 *
 * 被守的是 `SyncPerson` / `SyncOrgUnit`：这两张表的真相在源系统，业务代码写进去的
 * 那一行下次同步就被冲掉——而**没人会发现**，因为冲掉之后的样子跟「源系统本来
 * 就是这样」一模一样。所以默认拒一切写入，只有 `runWithSyncWrite` 包住的同步任务
 * 能写。
 *
 * 这套件要钉住的是四件事：
 *   1. 红：业务写被拒，连 includingDeleted 也过不去；
 *   2. 红：**嵌套写也绕不过去**——Prisma 的嵌套写跑在父查询里，query 扩展只
 *      回调父模型，不递归扫 args 就会从 `mentorProfile.create({ data: { person:
 *      { create: … } } })` 漏写 sync_person（深度 2 同理）；
 *   3. 绿：`connect` 不是写入，放行；同步作用域里 create / update 落库，
 *      **离场走 `update({ deletedAt })` 软删**，硬删在作用域里也仍被 R24 拒；
 *   4. 绿：**两条异步链的门互不串**——这是 sync-write-scope.ts 用
 *      AsyncLocalStorage 而不是模块级布尔的全部理由。
 *
 * 未覆盖：`$executeRaw*` 的裸 SQL 不触发查询扩展，守卫管不着（见
 * prisma.extension.ts「嵌套写守卫」那节的注释）。
 */

const SYNCED_AT = new Date('2026-10-27T00:00:00.000Z');

function orgUnitData(code: string): Prisma.SyncOrgUnitCreateInput {
  return {
    code,
    name: `单位-${code}`,
    syncedAt: SYNCED_AT,
    // 类型占位：扩展会剥掉并按当前操作者重写，运行时不会落这个 0n
    createdBy: 0n,
    updatedBy: 0n,
  };
}

function personData(login: string): Prisma.SyncPersonCreateInput {
  return {
    login,
    realName: `姓名-${login}`,
    personType: 'student',
    orgUnit: { create: orgUnitData(`ORG-${login}`) },
    syncedAt: SYNCED_AT,
    createdBy: 0n,
    updatedBy: 0n,
  };
}

/**
 * 守卫抛的是 {@link BusinessException}：错误码在 `getResponse()` 里，
 * 不在实例属性上。只 `rejects.toThrow(/…/)` 只能证明「抛了」，证不了「抛的是这个码」
 * ——而错误码是接口契约的一部分。
 */
async function expectSyncWriteForbidden(
  promise: Promise<unknown>,
): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );

  expect(error).toBeInstanceOf(BusinessException);
  expect((error as BusinessException).getResponse()).toMatchObject({
    code: ErrorCode.SYNC_WRITE_FORBIDDEN,
    data: null,
  });
  expect((error as BusinessException).getStatus()).toBe(HttpStatus.FORBIDDEN);
}

describe('同步层写入守卫 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    await clearSyncTables(prisma);
  });

  afterAll(async () => {
    await clearSyncTables(prisma);
    await app.close();
  });

  describe('红：业务代码写不进去', () => {
    it('SyncPerson 的七个写操作逐个被拒', async () => {
      await expectSyncWriteForbidden(
        prisma.client.syncPerson.create({ data: personData('p1') }),
      );
      await expectSyncWriteForbidden(
        prisma.client.syncPerson.createMany({ data: [] }),
      );
      await expectSyncWriteForbidden(
        prisma.client.syncPerson.update({
          where: { id: 1n },
          data: { realName: '改了' },
        }),
      );
      await expectSyncWriteForbidden(
        prisma.client.syncPerson.updateMany({
          data: { realName: '改了' },
        }),
      );
      await expectSyncWriteForbidden(
        prisma.client.syncPerson.upsert({
          where: { id: 1n },
          create: personData('p2'),
          update: { realName: '改了' },
        }),
      );
      await expectSyncWriteForbidden(
        prisma.client.syncPerson.delete({ where: { id: 1n } }),
      );
      await expectSyncWriteForbidden(prisma.client.syncPerson.deleteMany({}));
    });

    it('SyncOrgUnit 的七个写操作逐个被拒', async () => {
      await expectSyncWriteForbidden(
        prisma.client.syncOrgUnit.create({ data: orgUnitData('O1') }),
      );
      await expectSyncWriteForbidden(
        prisma.client.syncOrgUnit.createMany({ data: [] }),
      );
      await expectSyncWriteForbidden(
        prisma.client.syncOrgUnit.update({
          where: { id: 1n },
          data: { name: '改了' },
        }),
      );
      await expectSyncWriteForbidden(
        prisma.client.syncOrgUnit.updateMany({ data: { name: '改了' } }),
      );
      await expectSyncWriteForbidden(
        prisma.client.syncOrgUnit.upsert({
          where: { id: 1n },
          create: orgUnitData('O2'),
          update: { name: '改了' },
        }),
      );
      await expectSyncWriteForbidden(
        prisma.client.syncOrgUnit.delete({ where: { id: 1n } }),
      );
      await expectSyncWriteForbidden(prisma.client.syncOrgUnit.deleteMany({}));
    });

    it('includingDeleted 也过不去——那道墙在软删除分支之前', async () => {
      await expectSyncWriteForbidden(
        prisma.includingDeleted.syncPerson.deleteMany({}),
      );
      await expectSyncWriteForbidden(
        prisma.includingDeleted.syncOrgUnit.updateMany({
          data: { name: '改了' },
        }),
      );
    });

    it('读操作不受影响：黑名单只拦写，不误杀读', async () => {
      await expect(prisma.client.syncOrgUnit.findMany()).resolves.toEqual([]);
      await expect(prisma.client.syncPerson.count()).resolves.toBe(0);
      await expect(
        prisma.client.syncOrgUnit.findFirst({ where: { code: '不存在' } }),
      ).resolves.toBeNull();
    });

    it('深度 1 的嵌套写也绕不过去：MentorProfile.person.create', async () => {
      // 嵌套写跑在父查询里，query 扩展只回调 model='MentorProfile'。
      // 不递归扫 args 的话，这一行会直接写进 sync_person。
      await expectSyncWriteForbidden(
        prisma.client.mentorProfile.create({
          data: {
            person: { create: personData('nested-d1') },
            researchFields: [],
            createdBy: 0n,
            updatedBy: 0n,
          },
        }),
      );
    });

    it('connectOrCreate 的 create 分支同样被拒', async () => {
      // 静态拒：守卫看的是 args 形状，分不出「这次其实会 connect 到」。
      // 宁可把 connectOrCreate 整个按写入算——真要挂行，分开写 connect 就行。
      //
      // 顺带钉一个 Task 6 会撞上的事实：`where` **只能写 `id`**。`login` 的唯一性
      // 在 DB-11 生成列上（`login_active`），Prisma 表达不出来，所以
      // `SyncPersonWhereUniqueInput` 里没有 login——同步任务的「按工号配行」
      // 只能 findFirst({ where: { login } }) 再 create/update，不能 upsert。
      await expectSyncWriteForbidden(
        prisma.client.mentorProfile.create({
          data: {
            person: {
              connectOrCreate: {
                where: { id: 0n },
                create: personData('nested-cco'),
              },
            },
            researchFields: [],
            createdBy: 0n,
            updatedBy: 0n,
          },
        }),
      );
    });

    it('深度 2 也绕不过去：applications.create.applicant.create', async () => {
      // 中间那一层 MentorApplication 不是同步模型，不触发顶层守卫；
      // 递归要是只走一层，这条就漏过去了。
      const holder = await runWithSyncWrite(() =>
        prisma.client.syncPerson.create({ data: personData('nested-holder') }),
      );

      await expectSyncWriteForbidden(
        prisma.client.mentorProfile.create({
          data: {
            personId: holder.id,
            researchFields: [],
            createdBy: 0n,
            updatedBy: 0n,
            applications: {
              create: {
                applicant: { create: personData('nested-d2') },
                type: 1,
                snapshot: {},
                createdBy: 0n,
                updatedBy: 0n,
              },
            },
          },
        }),
      );
    });
  });

  describe('绿：不误伤——connect 放行，JSON 不当嵌套写', () => {
    it('person: { connect } 只改业务行的外键，落库', async () => {
      // connect 不写 sync_person 一个字节——它写的是 mentor_profile.person_id。
      // 一并拒掉会让「挂上一个同步来的人」这种正常操作无路可走。
      const person = await runWithSyncWrite(() =>
        prisma.client.syncPerson.create({ data: personData('connect-ok') }),
      );

      const profile = await prisma.client.mentorProfile.create({
        data: {
          person: { connect: { id: person.id } },
          researchFields: ['工程教育'],
          createdBy: 0n,
          updatedBy: 0n,
        },
      });

      expect(profile.personId).toBe(person.id);
    });

    it('JSON 列的值不当字段表：数据里叫 person 的键不是嵌套写', async () => {
      // `researchFields` 是 JSON 列。它的值里出现 `"person": { "create": … }`
      // 只是数据形状，不是 Prisma 的嵌套写——嵌套写挂在**关系字段**上。
      // 守卫要是把它当嵌套写，就会对一份正当的填报内容抛 403，而且文案还会
      // 指错方向（说你在写 SyncPerson）。walkNode 因此只在关系字段上下钻。
      const person = await runWithSyncWrite(() =>
        prisma.client.syncPerson.create({ data: personData('json-fp') }),
      );

      const profile = await prisma.client.mentorProfile.create({
        data: {
          person: { connect: { id: person.id } },
          researchFields: [{ person: { create: { login: 'not-a-write' } } }],
          createdBy: 0n,
          updatedBy: 0n,
        },
      });

      // 落库了，而且 JSON 原样存着——守卫一个字都没改它
      expect(profile.id).toBeDefined();
      expect(profile.researchFields).toEqual([
        { person: { create: { login: 'not-a-write' } } },
      ]);
    });
  });

  describe('绿：同步任务写得进去', () => {
    it('runWithSyncWrite 里的 create 落库，退出后读得到', async () => {
      const created = await runWithSyncWrite(() =>
        prisma.client.syncOrgUnit.create({ data: orgUnitData('SYNC-OK') }),
      );

      expect(created.id).toBeDefined();
      // 审计四字段由扩展填，跑在请求上下文之外时取 SYSTEM_USER_ID
      expect(created.createdBy).toBe(0n);

      const found = await prisma.client.syncOrgUnit.findFirst({
        where: { code: 'SYNC-OK' },
      });
      expect(found?.name).toBe('单位-SYNC-OK');
    });

    it('作用域跑完就关上：下一次写又被拒', async () => {
      await runWithSyncWrite(() =>
        prisma.client.syncOrgUnit.create({ data: orgUnitData('SCOPE-1') }),
      );

      await expectSyncWriteForbidden(
        prisma.client.syncOrgUnit.create({ data: orgUnitData('SCOPE-2') }),
      );
    });

    it('两条异步链的门互不串：一条开着，另一条照旧被拒', async () => {
      // 这条是 AsyncLocalStorage 的全部理由。换成模块级布尔开关，
      // 下面这个「外面的写」会被里面那条链顺手放行。
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const inside = runWithSyncWrite(async () => {
        await gate;
        return prisma.client.syncOrgUnit.create({
          data: orgUnitData('ALS-INSIDE'),
        });
      });

      await expectSyncWriteForbidden(
        prisma.client.syncOrgUnit.create({ data: orgUnitData('ALS-OUTSIDE') }),
      );
      expect(isSyncWriteScope()).toBe(false);

      release();
      await inside;
    });

    it('作用域里能软删：update 打 deletedAt 就是「离场」', async () => {
      // 需求 §2.1 的删是**软删 / 标记离场**，不是 delete。Task 6 的同步任务
      // 看到源系统少了一行，落的就是这一条 update，不是 deleteMany。
      const person = await runWithSyncWrite(() =>
        prisma.client.syncPerson.create({ data: personData('soft-del') }),
      );

      await runWithSyncWrite(() =>
        prisma.client.syncPerson.update({
          where: { id: person.id },
          data: {
            deletedAt: new Date('2026-10-27T01:00:00.000Z'),
            deletedBy: 0n,
          },
        }),
      );

      // 默认读看不见了
      await expect(
        prisma.client.syncPerson.findFirst({ where: { login: 'soft-del' } }),
      ).resolves.toBeNull();
      // includingDeleted 还看得见——软删不是物理删
      await expect(
        prisma.includingDeleted.syncPerson.findFirst({
          where: { login: 'soft-del' },
        }),
      ).resolves.toMatchObject({
        deletedAt: new Date('2026-10-27T01:00:00.000Z'),
      });
    });

    it('作用域里硬删照样被拒——离场没有第二条路', async () => {
      // R24 那道守卫在同步守卫**之后**，所以连同步作用域也过不去。
      // 这不是缺陷：需求 §2.1 的「删」就是软删，delete/deleteMany 不该有入口。
      // 钉住它是为了 Task 6 不要去找「同步任务专用的硬删入口」——那个入口不存在。
      const person = await runWithSyncWrite(() =>
        prisma.client.syncPerson.create({ data: personData('hard-del') }),
      );

      await expect(
        runWithSyncWrite(() =>
          prisma.client.syncPerson.delete({ where: { id: person.id } }),
        ),
      ).rejects.toThrow(/R24/);

      // 行还在（软删语义下「没被删」）
      await expect(
        prisma.client.syncPerson.findFirst({ where: { login: 'hard-del' } }),
      ).resolves.toMatchObject({ login: 'hard-del' });
    });
  });
});

/**
 * 清残留。**走裸 SQL**：清库是测试的运维动作，不是业务写入，而且它不能依赖
 * 正被测的那道守卫——用 `runWithSyncWrite` 清，等于让失灵的门自己擦掉证据。
 * 顺序按外键拓扑序（业务表 → sync_person → sync_org_unit）。
 */
async function clearSyncTables(prisma: PrismaService): Promise<void> {
  await prisma.client.$executeRawUnsafe(
    'DELETE FROM mentor_application_material',
  );
  await prisma.client.$executeRawUnsafe('DELETE FROM mentor_application');
  await prisma.client.$executeRawUnsafe('DELETE FROM mentor_profile');
  await prisma.client.$executeRawUnsafe('DELETE FROM sync_person');
  await prisma.client.$executeRawUnsafe('DELETE FROM sync_org_unit');
}
