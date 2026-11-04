import type { Server } from 'node:http';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ErrorCode } from '../src/common/constants/error-code';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import type { AuthTokensResponseDto } from '../src/modules/auth/dto/auth-tokens.response.dto';
import { MockSyncSource } from '../src/modules/sync/mock-source';
import { ProjectionWriter } from '../src/modules/sync/projection';
import {
  DETAIL_REASON,
  SyncRunStatus,
  type SyncRunDetail,
} from '../src/modules/sync/sync.constants';
import { SyncPersonRepository } from '../src/modules/sync/sync-person.repository';
import { SyncService } from '../src/modules/sync/sync.service';
import { clearBusinessTables, clearRedisKeys } from './e2e-helpers';

/**
 * 同步框架 + 投影（Task 6a）的 e2e。五条判据逐条对得上 brief：
 *
 *   1. 一次同步跑通，`SyncRun` 落一条 `status = OK|PARTIAL|FAILED`
 *   2. 失败明细可见（ERR-07）：`SyncRun.detail` 记 `{ kind, key, reason }`，不静默
 *   3. 幂等：同一批跑两次，四张表**逐行逐列完全相等**（含审计列）
 *   4. 软删用例：源系统删人 → `deleted_at` 落值 → 历史业务数据仍能关联到人
 *   5. 投影用例：同步一批人 → `SysUser` 出现账号且能登录；源系统删人 → 账号停用但不消失
 *
 * 「能登录」走的是真实入口 `GET /auth/sso/callback`（SSO_PROVIDER 默认 mock，
 * `ticket` 就是工号），不是绕过鉴权直接查库——投影的全部意义就是让这个回调能成。
 *
 * 用 `MentorProfile` 代表「他名下的历史业务数据」：判据原文写的是预约 / 指导记录，
 * 那些是 P2 的表；关联机制是同一条（业务表挂 `SyncPerson.id`，不冗余姓名学院）。
 *
 * 判据 4 / 5 的离场走显式 `{ mode: 'full' }`。**不是默认路径**：
 * 增量批里少一行只说明「这次没变」（Ruling 23），只有 `since === null` 的全量跑
 * 才认「批里没有 = 源系统删了」。定期全量是运维约定，本期没有调度器。
 */
describe('同步框架 + 投影 (e2e)', () => {
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
      if (redis !== undefined) await clearRedisKeys(redis);
    } finally {
      if (app !== undefined) await app.close();
    }
  });

  /** 每条用例自己起一套干净的库——这几条互相不共享状态 */
  async function reset(): Promise<void> {
    await clearBusinessTables(prisma);
    await clearSyncTables(prisma);
    await clearRedisKeys(redis);
  }

  /** 角色是**管理员配的**，同步任务不自建（Ruling 24）。用例自己种 */
  async function seedRole(code: string, name: string): Promise<void> {
    await prisma.client.sysRole.create({
      data: {
        code,
        name,
        dataScope: 'self',
        status: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
  }

  async function seedRoles(): Promise<void> {
    await seedRole('student', '学生');
    await seedRole('mentor', '导师');
  }

  async function readDetail(runId: bigint): Promise<SyncRunDetail> {
    const run = await prisma.client.syncRun.findFirst({ where: { id: runId } });
    if (run === null) throw new Error(`流水 ${runId} 不在`);
    return run.detail as unknown as SyncRunDetail;
  }

  async function readStartedAt(runId: bigint): Promise<Date> {
    const run = await prisma.client.syncRun.findFirst({ where: { id: runId } });
    if (run === null) {
      throw new Error(`流水 ${runId} 不在`);
    }
    return run.startedAt;
  }

  /** 取一个带 state 的 authorize URL，并把 state 解出来（照 auth-sso 的写法） */
  async function fetchAuthorizeState(): Promise<string> {
    const response = await request(app.getHttpServer() as Server)
      .get('/auth/sso/authorize')
      .expect(200);
    const body = response.body as ResponseEnvelope<{ authorizeUrl: string }>;
    const state = new URL(
      body.data.authorizeUrl,
      'http://localhost',
    ).searchParams.get('state');
    if (state === null) throw new Error('authorizeUrl 里没有 state');
    return state;
  }

  /** 用 SSO 登一次。**这就是判据里的「能登录」**，不是查库 */
  async function loginViaSso(login: string): Promise<{
    status: number;
    code: number;
    tokens?: AuthTokensResponseDto;
  }> {
    const state = await fetchAuthorizeState();
    const response = await request(app.getHttpServer() as Server)
      .get('/auth/sso/callback')
      .query({ state, ticket: login });
    const body = response.body as ResponseEnvelope<AuthTokensResponseDto>;
    return {
      status: response.status,
      code: body.code,
      tokens: response.status === 200 ? body.data : undefined,
    };
  }

  // ----------------------------------------------------------------

  describe('判据 1：一次同步跑通', () => {
    it('组织先落、人员后落，父子树与账号都对，SyncRun 记 OK', async () => {
      await reset();
      await seedRoles();

      const source = new MockSyncSource();
      source.orgUnits = [
        { code: 'T6-A', name: '计算机学院', parentCode: null, kind: '学院' },
        // 儿子排在父亲**前面**：一遍写完解决不了「儿子先到、父亲后到」，
        // 少了拓扑序这条就会挂在 null 上
        { code: 'T6-B', name: '软件工程系', parentCode: 'T6-A', kind: '系所' },
      ];
      source.persons = [
        {
          login: 'T6-S1',
          realName: '学生甲',
          personType: 'student',
          orgUnitCode: 'T6-B',
          major: '软件工程',
          className: '软工2301',
          mobile: '13800000001',
        },
        {
          login: 'T6-M1',
          realName: '导师甲',
          personType: 'internalMentor',
          orgUnitCode: 'T6-A',
          major: null,
          className: null,
          mobile: null,
        },
      ];

      const result = await sync.runOnce(source, { mode: 'full' });

      expect(result.status).toBe(SyncRunStatus.OK);
      expect(result).toMatchObject({ total: 4, okCount: 4, failCount: 0 });

      const run = await prisma.client.syncRun.findFirst({
        where: { id: result.runId },
      });
      expect(run).toMatchObject({
        source: 'mock',
        status: SyncRunStatus.OK,
        total: 4,
        okCount: 4,
        failCount: 0,
      });

      // 同步层：两行都落了，出处是这一次跑
      const units = await prisma.client.syncOrgUnit.findMany({
        orderBy: { code: 'asc' },
      });
      expect(units.map((u) => u.code)).toEqual(['T6-A', 'T6-B']);
      expect(units.every((u) => u.syncRunId === result.runId)).toBe(true);

      // 投影：部门树对上（T6-B 的父是 T6-A 投影出来的那条）
      const parent = await prisma.client.sysDept.findFirst({
        where: { name: '计算机学院' },
      });
      const child = await prisma.client.sysDept.findFirst({
        where: { name: '软件工程系' },
      });
      expect(parent).not.toBeNull();
      expect(child).toMatchObject({ parentId: parent?.id });

      // 投影：账号出来了，`username` 与 `employeeNo` 都取 login
      const student = await prisma.client.sysUser.findFirst({
        where: { username: 'T6-S1' },
      });
      expect(student).toMatchObject({
        employeeNo: 'T6-S1',
        realName: '学生甲',
        mobile: '13800000001',
        deptId: child?.id,
        status: 1,
        isSuperAdmin: false,
      });

      // 默认角色按 personType 绑（Ruling 24）
      const studentRole = await prisma.client.sysRole.findFirst({
        where: { code: 'student' },
      });
      await expect(
        prisma.client.sysUserRole.findFirst({
          where: { userId: student?.id, roleId: studentRole?.id },
        }),
      ).resolves.not.toBeNull();

      const mentor = await prisma.client.sysUser.findFirst({
        where: { username: 'T6-M1' },
      });
      const mentorRole = await prisma.client.sysRole.findFirst({
        where: { code: 'mentor' },
      });
      await expect(
        prisma.client.sysUserRole.findFirst({
          where: { userId: mentor?.id, roleId: mentorRole?.id },
        }),
      ).resolves.not.toBeNull();
    });
  });

  describe('判据 5：投影出来的账号能登录，删人后停用但不消失', () => {
    it('SSO 回调能换到双令牌；源系统删人后账号还在、只是登不进去', async () => {
      await reset();
      await seedRoles();

      const source = new MockSyncSource();
      source.orgUnits = [
        { code: 'T6-A', name: '计算机学院', parentCode: null, kind: null },
      ];
      source.persons = [
        {
          login: 'T6-S1',
          realName: '学生甲',
          personType: 'student',
          orgUnitCode: 'T6-A',
          major: null,
          className: null,
          mobile: null,
        },
      ];
      await sync.runOnce(source, { mode: 'full' });

      // 能登录：这是判据原文，走的是真实入口
      const ok = await loginViaSso('T6-S1');
      expect(ok.status).toBe(200);
      expect(ok.code).toBe(0);
      expect(typeof ok.tokens?.accessToken).toBe('string');

      // 源系统删人 → 账号停用但不消失
      source.persons = [];
      const retired = await sync.runOnce(source, { mode: 'full' });
      expect(retired.status).toBe(SyncRunStatus.OK);
      // 计数把离场那行也算进去了（Ruling 26）：1 个 org + 0 个批内 person + 1 个离场
      expect(retired).toMatchObject({ total: 2, okCount: 2, failCount: 0 });

      const user = await prisma.client.sysUser.findFirst({
        where: { username: 'T6-S1' },
      });
      expect(user).not.toBeNull();
      expect(user?.status).toBe(0);

      // 「不消失」的可观察面：SSO 认得这个人，只是不放他进来（401 / 20102），
      // 而不是「本地无此工号」的 403 / 20107
      const denied = await loginViaSso('T6-S1');
      expect(denied.status).toBe(401);
      expect(denied.code).toBe(ErrorCode.AUTH_ACCOUNT_DISABLED);
    });
  });

  describe('判据 4：源系统删行 → 软删，历史业务数据仍能关联到人', () => {
    it('SyncPerson 打 deleted_at，名下档案还能按 personId 查出来', async () => {
      await reset();
      await seedRoles();

      const source = new MockSyncSource();
      source.orgUnits = [
        { code: 'T6-A', name: '计算机学院', parentCode: null, kind: null },
      ];
      source.persons = [
        {
          login: 'T6-S1',
          realName: '学生甲',
          personType: 'student',
          orgUnitCode: 'T6-A',
          major: null,
          className: null,
          mobile: null,
        },
      ];
      await sync.runOnce(source, { mode: 'full' });

      const person = await prisma.client.syncPerson.findFirst({
        where: { login: 'T6-S1' },
      });
      expect(person).not.toBeNull();

      // 一条挂在他名下的业务数据
      await prisma.client.mentorProfile.create({
        data: {
          personId: person?.id ?? 0n,
          researchFields: ['工程教育'],
          createdBy: 0n,
          updatedBy: 0n,
        },
      });

      source.persons = [];
      await sync.runOnce(source, { mode: 'full' });

      // 同步行软删——不是物理删
      await expect(
        prisma.client.syncPerson.findFirst({ where: { login: 'T6-S1' } }),
      ).resolves.toBeNull();
      const gone = await prisma.includingDeleted.syncPerson.findFirst({
        where: { login: 'T6-S1' },
      });
      expect(gone?.deletedAt).not.toBeNull();

      // 历史业务数据还在，而且还能关联到人
      const profile = await prisma.client.mentorProfile.findFirst({
        where: { personId: person?.id ?? 0n },
      });
      expect(profile).not.toBeNull();
      expect(profile?.researchFields).toEqual(['工程教育']);
    });

    it('增量批里少一行不等于删除（Ruling 23）', async () => {
      await reset();
      await seedRoles();

      const source = new MockSyncSource();
      source.orgUnits = [
        { code: 'T6-A', name: '计算机学院', parentCode: null, kind: null },
      ];
      source.persons = [
        {
          login: 'T6-S1',
          realName: '学生甲',
          personType: 'student',
          orgUnitCode: 'T6-A',
          major: null,
          className: null,
          mobile: null,
        },
      ];
      await sync.runOnce(source, { mode: 'full' });

      // 增量跑里这行不见了 —— 只说明「这次没变」
      source.persons = [];
      await sync.runOnce(source);

      await expect(
        prisma.client.syncPerson.findFirst({ where: { login: 'T6-S1' } }),
      ).resolves.not.toBeNull();
      const user = await prisma.client.sysUser.findFirst({
        where: { username: 'T6-S1' },
      });
      expect(user?.status).toBe(1);
    });
  });

  describe('判据 3：幂等——同一批跑两次，四张表逐行逐列完全相等', () => {
    it('第二次跑一个字都不写，连审计列都不动', async () => {
      await reset();
      await seedRoles();

      const source = new MockSyncSource();
      source.orgUnits = [
        { code: 'T6-A', name: '计算机学院', parentCode: null, kind: '学院' },
        { code: 'T6-B', name: '软件工程系', parentCode: 'T6-A', kind: '系所' },
      ];
      source.persons = [
        {
          login: 'T6-S1',
          realName: '学生甲',
          personType: 'student',
          orgUnitCode: 'T6-B',
          major: '软件工程',
          className: '软工2301',
          mobile: '13800000001',
        },
        {
          login: 'T6-M1',
          realName: '导师甲',
          personType: 'externalMentor',
          orgUnitCode: 'T6-A',
          major: null,
          className: null,
          mobile: null,
        },
      ];

      await sync.runOnce(source, { mode: 'full' });
      const first = await snapshot(prisma);

      await sync.runOnce(source, { mode: 'full' });
      const second = await snapshot(prisma);

      // `updated_at` 也在比较范围里——它正是「跳过写入」的证伪点：
      // 把跳过改成无脑 update，扩展会重写这一列，这里立刻红
      expect(second).toEqual(first);
    });
  });

  describe('判据 2：失败明细可见（ERR-07）', () => {
    it('缺角色 → 该行失败、进 detail，其余照跑，status = PARTIAL', async () => {
      await reset();
      // **不种角色**：角色是管理员配的，同步任务不自建

      const source = new MockSyncSource();
      source.orgUnits = [
        { code: 'T6-A', name: '计算机学院', parentCode: null, kind: null },
      ];
      source.persons = [
        {
          login: 'T6-S1',
          realName: '学生甲',
          personType: 'student',
          orgUnitCode: 'T6-A',
          major: null,
          className: null,
          mobile: null,
        },
      ];

      const result = await sync.runOnce(source, { mode: 'full' });

      expect(result.status).toBe(SyncRunStatus.PARTIAL);
      expect(result).toMatchObject({ total: 2, okCount: 1, failCount: 1 });

      const detail = await readDetail(result.runId);
      expect(detail.mode).toBe('full');
      expect(detail.since).toBeNull();
      expect(detail.failures).toEqual([
        {
          kind: 'person',
          key: 'T6-S1',
          reason: `${DETAIL_REASON.ROLE_MISSING}:student`,
        },
      ]);
    });

    it('一行都没成 → status = FAILED，不是 OK', async () => {
      await reset();
      await seedRoles();

      // 单位列表为空，两个人都指向一个不存在的单位：两行都挂
      const source = new MockSyncSource();
      source.orgUnits = [];
      source.persons = [
        {
          login: 'T6-S1',
          realName: '学生甲',
          personType: 'student',
          orgUnitCode: 'T6-A',
          major: null,
          className: null,
          mobile: null,
        },
        {
          login: 'T6-M1',
          realName: '导师甲',
          personType: 'internalMentor',
          orgUnitCode: 'T6-A',
          major: null,
          className: null,
          mobile: null,
        },
      ];

      const result = await sync.runOnce(source, { mode: 'full' });

      expect(result.status).toBe(SyncRunStatus.FAILED);
      expect(result).toMatchObject({ total: 2, okCount: 0, failCount: 2 });
      expect(result.failures).toEqual([
        {
          kind: 'person',
          key: 'T6-S1',
          reason: `${DETAIL_REASON.ORG_NOT_FOUND}:T6-A`,
        },
        {
          kind: 'person',
          key: 'T6-M1',
          reason: `${DETAIL_REASON.ORG_NOT_FOUND}:T6-A`,
        },
      ]);
    });

    it('拉数失败 = 整批 FAILED，detail 记 exception', async () => {
      await reset();
      await seedRoles();

      const source = new MockSyncSource();
      source.fetchError = new Error('学工系统连不上');

      const result = await sync.runOnce(source, { mode: 'full' });

      expect(result.status).toBe(SyncRunStatus.FAILED);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({
        kind: 'orgUnit',
        key: 'mock',
      });
      expect(result.failures[0]?.reason).toContain(
        `${DETAIL_REASON.EXCEPTION}:`,
      );
      expect(result.failures[0]?.reason).toContain('学工系统连不上');

      // 拉数都够不着，就不该动库
      await expect(prisma.client.syncOrgUnit.count()).resolves.toBe(0);
    });

    it('组织树成环 → 环上每一行都记 org_cycle，不是只记回头那行', async () => {
      await reset();
      await seedRoles();

      const source = new MockSyncSource();
      source.orgUnits = [
        { code: 'T6-A', name: '甲院', parentCode: 'T6-B', kind: null },
        { code: 'T6-B', name: '乙院', parentCode: 'T6-A', kind: null },
      ];

      const result = await sync.runOnce(source, { mode: 'full' });

      expect(result.status).toBe(SyncRunStatus.FAILED);
      expect(result).toMatchObject({ total: 2, okCount: 0, failCount: 2 });
      expect(result.failures.map((f) => f.reason).sort()).toEqual([
        DETAIL_REASON.ORG_CYCLE,
        DETAIL_REASON.ORG_CYCLE,
      ]);
    });
  });

  describe('Ruling 22：源系统改名不换部门', () => {
    it('同 code 改名 → 同一条 SysDept 更新，sys_user.dept_id 不动', async () => {
      await reset();
      await seedRoles();

      const source = new MockSyncSource();
      source.orgUnits = [
        { code: 'T6-A', name: '计算机学院', parentCode: null, kind: null },
      ];
      source.persons = [
        {
          login: 'T6-S1',
          realName: '学生甲',
          personType: 'student',
          orgUnitCode: 'T6-A',
          major: null,
          className: null,
          mobile: null,
        },
      ];
      await sync.runOnce(source, { mode: 'full' });

      const before = await prisma.client.sysDept.findFirst({
        where: { name: '计算机学院' },
      });

      source.orgUnits = [
        {
          code: 'T6-A',
          name: '计算机与人工智能学院',
          parentCode: null,
          kind: null,
        },
      ];
      await sync.runOnce(source, { mode: 'full' });

      const after = await prisma.client.sysDept.findFirst({
        where: { name: '计算机与人工智能学院' },
      });
      // 同一条，不是「旧的软删 + 新的建一条」
      expect(after?.id).toBe(before?.id);
      await expect(
        prisma.client.sysDept.findFirst({ where: { name: '计算机学院' } }),
      ).resolves.toBeNull();

      // 用户还挂在原来那条部门上——按名字配行的话这里就指向软删行了
      const user = await prisma.client.sysUser.findFirst({
        where: { username: 'T6-S1' },
      });
      expect(user?.deptId).toBe(before?.id);
    });
  });

  describe('水位：PARTIAL 也推进，失败行靠全量重试', () => {
    it('PARTIAL 推进水位到 startedAt - 5min；显式 full 才重试失败行', async () => {
      await reset();
      await seedRoles();

      const source = new MockSyncSource();
      source.orgUnits = [
        { code: 'T6-A', name: '计算机学院', parentCode: null, kind: null },
      ];

      // 第一次：没有水位 → 全量
      const first = await sync.runOnce(source);
      expect(first.mode).toBe('full');
      expect(source.seenSince[0]).toBeNull();

      // 第二次：水位在 → 增量，起点是第一次 startedAt - 5 分钟
      const second = await sync.runOnce(source);
      expect(second.mode).toBe('incremental');
      expect(source.seenSince[1]).toEqual(
        new Date((await readStartedAt(first.runId)).getTime() - 5 * 60 * 1000),
      );

      // 制造一次 PARTIAL：加一个缺角色的人
      source.persons = [
        {
          login: 'T6-S1',
          realName: '学生甲',
          personType: 'student',
          orgUnitCode: 'T6-A',
          major: null,
          className: null,
          mobile: null,
        },
      ];
      await prisma.includingDeleted.sysRole.deleteMany({
        where: { code: 'student' },
      });
      const partial = await sync.runOnce(source);
      expect(partial.status).toBe(SyncRunStatus.PARTIAL);
      expect(partial.mode).toBe('incremental');

      // PARTIAL 也推进水位：下一次增量从本次 startedAt - 5min 开始
      const partialSince = new Date(
        (await readStartedAt(partial.runId)).getTime() - 5 * 60 * 1000,
      );
      const retried = await sync.runOnce(source);
      expect(retried.mode).toBe('incremental');
      expect(source.seenSince[3]).toEqual(partialSince);

      // 显式全量：since = null，失败行被重新处理
      await seedRole('student', '学生');
      const full = await sync.runOnce(source, { mode: 'full' });
      expect(full.mode).toBe('full');
      expect(source.seenSince[4]).toBeNull();
      expect(full.status).toBe(SyncRunStatus.OK);
      await expect(
        prisma.client.sysUser.findFirst({ where: { username: 'T6-S1' } }),
      ).resolves.not.toBeNull();
    });
  });

  describe('离场的写序（评审 MAJOR）', () => {
    /**
     * `runWithSyncWrite` 只是 AsyncLocalStorage 作用域，**不是事务**——
     * 中途抛异常不回滚。所以离场两笔写的先后顺序决定失败落在哪一边：
     *
     *   先软删同步行 → 投影写失败 ⇒ 同步行已经没了，`listActive()` 再也看不到它，
     *                      下一次不会重试。源系统删掉的人一直能登录。**坏**。
     *   先投影、后软删同步行 → 投影写失败 ⇒ 同步行还在，下一次原样重试。
     *                      失败落在「账号已停用、同步行还没标离场」，安全且可自愈。
     */
    it('投影停用失败 → 同步行不许已经软删，下一次还能补上', async () => {
      await reset();
      await seedRoles();

      const source = new MockSyncSource();
      source.orgUnits = [
        { code: 'T6-A', name: '计算机学院', parentCode: null, kind: null },
      ];
      source.persons = [
        {
          login: 'T6-S1',
          realName: '学生甲',
          personType: 'student',
          orgUnitCode: 'T6-A',
          major: null,
          className: null,
          mobile: null,
        },
      ];
      await sync.runOnce(source, { mode: 'full' });

      // 让投影那一笔挂掉
      const projection = app.get(ProjectionWriter);
      const spy = jest
        .spyOn(projection, 'disableUser')
        .mockRejectedValue(new Error('投影写坏了'));

      source.persons = [];
      const broken = await sync.runOnce(source, { mode: 'full' });

      // 这一行失败了，而且必须看得见（ERR-07）
      expect(broken.status).toBe(SyncRunStatus.PARTIAL);
      expect(broken.failures).toHaveLength(1);
      expect(broken.failures[0]).toMatchObject({
        kind: 'person',
        key: 'T6-S1',
      });
      expect(broken.failures[0]?.reason).toContain(DETAIL_REASON.EXCEPTION);

      // 关键：同步行**还在**，没有被提前软删
      await expect(
        prisma.client.syncPerson.findFirst({ where: { login: 'T6-S1' } }),
      ).resolves.not.toBeNull();

      // 修好了之后，下一次跑能补上——这就是「可重试」
      spy.mockRestore();
      const healed = await sync.runOnce(source, { mode: 'full' });
      expect(healed.status).toBe(SyncRunStatus.OK);
      await expect(
        prisma.client.syncPerson.findFirst({ where: { login: 'T6-S1' } }),
      ).resolves.toBeNull();
      const user = await prisma.client.sysUser.findFirst({
        where: { username: 'T6-S1' },
      });
      expect(user?.status).toBe(0);
    });
  });

  describe('批级逃逸要收口（评审 MINOR）', () => {
    it('离场阶段抛出 runOnce 不许抛，流水也不许停在 RUNNING', async () => {
      await reset();
      await seedRoles();

      const source = new MockSyncSource();
      source.orgUnits = [
        { code: 'T6-A', name: '计算机学院', parentCode: null, kind: null },
      ];
      await sync.runOnce(source, { mode: 'full' });

      const persons = app.get(SyncPersonRepository);
      const spy = jest
        .spyOn(persons, 'listActive')
        .mockRejectedValue(new Error('库连不上'));

      // 不该往外抛：往外抛 = 调用方收不到 runId，流水永远停在 RUNNING
      const result = await sync.runOnce(source, { mode: 'full' });
      spy.mockRestore();

      // 账目：批里 T6-A 那一行是**成功**的（ok 1），逃逸再记一条失败（fail 1）。
      // 逃逸不是「整批作废」——已写下去的还在，所以按 brief §2.4 的冻结口径
      // 这是 PARTIAL 不是 FAILED。assert 要的是「逃逸被记下来」，不是某个枚举值
      expect(result).toMatchObject({
        status: SyncRunStatus.PARTIAL,
        total: 2,
        okCount: 1,
        failCount: 1,
      });
      expect(result.failures).toHaveLength(1);
      // 逃逸记在 source 名下（与拉数失败同一形状），不是记在某一行头上
      expect(result.failures[0]).toMatchObject({
        kind: 'orgUnit',
        key: source.name,
      });
      expect(result.failures[0]?.reason).toContain(DETAIL_REASON.EXCEPTION);

      // 流水收口了，而且失败明细进了 detail（不许只留一个计数）
      const run = await prisma.client.syncRun.findFirst({
        where: { id: result.runId },
      });
      expect(run?.status).toBe(SyncRunStatus.PARTIAL);
      expect(run?.finishedAt).not.toBeNull();
      const detail = await readDetail(result.runId);
      expect(detail.failures).toEqual(result.failures);
    });
  });

  describe('同一批里重复自然键（评审 MINOR）', () => {
    it('后到的那条记 unique_key_conflict，账目不许把两行合成一行数', async () => {
      await reset();
      await seedRoles();

      const source = new MockSyncSource();
      source.orgUnits = [
        { code: 'T6-A', name: '计算机学院', parentCode: null, kind: null },
        // 源数据坏了：同一个 code 来了两条
        {
          code: 'T6-A',
          name: '计算机学院（重复）',
          parentCode: null,
          kind: null,
        },
      ];

      const result = await sync.runOnce(source, { mode: 'full' });

      // 两行都要进账：一行成、一行记冲突
      expect(result).toMatchObject({ total: 2, okCount: 1, failCount: 1 });
      expect(result.status).toBe(SyncRunStatus.PARTIAL);
      expect(result.failures).toEqual([
        {
          kind: 'orgUnit',
          key: 'T6-A',
          reason: DETAIL_REASON.UNIQUE_KEY_CONFLICT,
        },
      ]);
    });
  });
});

/**
 * 清残留。**走裸 SQL**：清库是测试的运维动作，不是业务写入，而且不能依赖正被测的
 * 那套守卫（用 `runWithSyncWrite` 清，等于让失灵的门自己擦掉证据）。
 * 顺序按外键拓扑序（见 `prisma/schema.prisma` 的 `@relation(fields: [...])`）。
 */
async function clearSyncTables(prisma: PrismaService): Promise<void> {
  const tables = [
    'assessment_appeal',
    'achievement',
    'assessment',
    'guidance_material',
    'guidance_record',
    'student_review',
    'appointment_material',
    'appointment',
    'mentor_time_slot',
    'mentor_application_material',
    'mentor_application',
    'archive_item',
    'mentor_profile',
    'sync_person',
    'sync_org_unit',
    'sync_run',
  ];
  for (const table of tables) {
    await prisma.client.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
}

/**
 * 幂等判据要的四张表全量快照，**含审计列**。
 * `sys_dept` / `sys_user` 走 `includingDeleted`：软删的行也得进比较，
 * 不然「第一遍软删、第二遍复活」这种抖动会被当成相等。
 */
async function snapshot(prisma: PrismaService): Promise<{
  syncOrgUnit: unknown[];
  syncPerson: unknown[];
  sysDept: unknown[];
  sysUser: unknown[];
}> {
  return {
    syncOrgUnit: await prisma.client.syncOrgUnit.findMany({
      orderBy: { id: 'asc' },
    }),
    syncPerson: await prisma.client.syncPerson.findMany({
      orderBy: { id: 'asc' },
    }),
    sysDept: await prisma.includingDeleted.sysDept.findMany({
      orderBy: { id: 'asc' },
    }),
    sysUser: await prisma.includingDeleted.sysUser.findMany({
      orderBy: { id: 'asc' },
    }),
  };
}
