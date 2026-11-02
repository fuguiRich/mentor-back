import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Appointment, MentorProfile, SyncPerson } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { runWithSyncWrite } from '../src/infra/prisma/sync-write-scope';
import { ErrorCode } from '../src/common/constants/error-code';
import type { FieldErrorDto } from '../src/common/dto/field-error.dto';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import type { PermissionResponseDto } from '../src/modules/permission/dto/permission-response.dto';
import type { RoleResponseDto } from '../src/modules/role/dto/role-response.dto';
import type { AppointmentResponseDto } from '../src/modules/appointment/dto/appointment-response.dto';
import { AppointmentService } from '../src/modules/appointment/appointment.service';
import {
  authedAgent,
  clearBusinessTables,
  clearModuleTables,
  clearRedisKeys,
  loginAs,
  seedSuperAdmin,
  seedUser,
  type E2eApi,
} from './e2e-helpers';

const SYNCED_AT = new Date('2026-10-27T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * 学生取消 / 超时扫描（e2e）—— Task 25 的全部判据。
 *
 * 共享库态、`maxWorkers: 1` 串行。取消用例**各自造自己的预约行**，互不依赖；
 * 超时扫描用例在开头清空 `appointment`，再用「把 `now` 往后推」而不是改
 * `createdAt` 来造「过期」——审计扩展在 create 时会把 `createdAt` 重写成当前
 * 时间（DB-06），想改它只能走裸 SQL，而本任务不新增裸 SQL。
 *
 * 角色：
 * - 学生 S001（预约的申请人）、S002（另一个学生，用来钉 403 / 32002）；
 * - 导师 T001（预约的导师，用来钉「导师取消 → 403 / 32002」）。
 *
 * T001 也带 `appointment:create`：否则权限守卫会先把它挡成 403 / 10003，
 * 测不到服务层的「不是申请人本人」那条 403 / 32002。
 */
describe('预约取消与超时扫描 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let appointments: AppointmentService;

  let adminApi: E2eApi;
  const agents = new Map<string, E2eApi>();
  const permissionIds = new Map<string, string>();
  const deptIds = new Map<string, bigint>();
  const people = new Map<string, SyncPerson>();
  const profiles = new Map<string, MentorProfile>();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    appointments = app.get(AppointmentService);

    await clearBusinessTables(prisma);
    await clearAppointmentAndSyncTables(prisma);
    await clearModuleTables(prisma);
    await clearRedisKeys(redis);

    const admin = await seedSuperAdmin(prisma);
    const adminTokens = await loginAs(app, admin.username, admin.password);
    adminApi = authedAgent(app, adminTokens.accessToken);

    const rootDept = await prisma.client.sysDept.findFirst({
      where: { name: '总公司' },
    });
    if (rootDept === null) {
      throw new Error('seedSuperAdmin 未种出「总公司」部门');
    }
    deptIds.set('A', await createDept('学院 A', rootDept.id));
    deptIds.set('B', await createDept('学院 B', rootDept.id));

    const orgA = await createOrg('ORG-CANCEL-A', '学院 A 组织', dept('A'));
    const orgB = await createOrg('ORG-CANCEL-B', '学院 B 组织', dept('B'));

    const identities: Array<[string, string, bigint]> = [
      ['S001', 'student', orgA],
      ['S002', 'student', orgB],
      ['T001', 'internalMentor', orgA],
    ];
    for (const [login, personType, orgUnitId] of identities) {
      const person = await runWithSyncWrite(() =>
        prisma.client.syncPerson.create({
          data: {
            login,
            realName: login,
            personType,
            orgUnitId,
            syncedAt: SYNCED_AT,
            createdBy: 0n,
            updatedBy: 0n,
          },
        }),
      );
      people.set(login, person);
    }

    const studentRole = await createRoleWithCodes(
      '取消学生角色',
      'cancel_student',
      'self',
      ['appointment:create'],
    );
    // 导师也带 appointment:create：见文件头「T001 也带…」的理由
    const mentorRole = await createRoleWithCodes(
      '取消导师角色',
      'cancel_mentor',
      'self',
      ['appointment:create', 'appointment:handle'],
    );

    const users: Array<[string, bigint, RoleResponseDto]> = [
      ['S001', dept('A'), studentRole],
      ['S002', dept('B'), studentRole],
      ['T001', dept('A'), mentorRole],
    ];
    for (const [username, deptId, role] of users) {
      const user = await seedUser(prisma, { username, deptId });
      await linkUserRole(user.userId, BigInt(role.id));
    }

    for (const login of ['S001', 'S002', 'T001']) {
      const tokens = await loginAs(app, login, 'Passw0rd!');
      agents.set(login, authedAgent(app, tokens.accessToken));
    }

    const profile = await prisma.client.mentorProfile.create({
      data: {
        personId: personId('T001'),
        researchFields: [],
        status: 2,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    profiles.set('T001', profile);
  });

  afterAll(async () => {
    try {
      if (prisma !== undefined) {
        await clearAppointmentAndSyncTables(prisma);
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

  // ── 造数助手 ──────────────────────────────────────────────────────

  function dept(key: string): bigint {
    const id = deptIds.get(key);
    if (id === undefined) {
      throw new Error(`没有 ${key} 部门`);
    }
    return id;
  }

  function personId(login: string): bigint {
    const person = people.get(login);
    if (person === undefined) {
      throw new Error(`没有 ${login} 的 SyncPerson`);
    }
    return person.id;
  }

  function profileOf(login: string): MentorProfile {
    const profile = profiles.get(login);
    if (profile === undefined) {
      throw new Error(`没有 ${login} 的导师档案`);
    }
    return profile;
  }

  function api(login: string): E2eApi {
    const agent = agents.get(login);
    if (agent === undefined) {
      throw new Error(`没有 ${login} 的登录态`);
    }
    return agent;
  }

  async function createDept(name: string, parentId: bigint): Promise<bigint> {
    const row = await prisma.client.sysDept.create({
      data: {
        parentId,
        name,
        sortOrder: 0,
        status: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    return row.id;
  }

  async function createOrg(
    code: string,
    name: string,
    deptId: bigint,
  ): Promise<bigint> {
    const row = await runWithSyncWrite(() =>
      prisma.client.syncOrgUnit.create({
        data: {
          code,
          name,
          kind: 'college',
          deptId,
          syncedAt: SYNCED_AT,
          createdBy: 0n,
          updatedBy: 0n,
        },
      }),
    );
    return row.id;
  }

  async function ensurePermissionId(code: string): Promise<string> {
    const cached = permissionIds.get(code);
    if (cached !== undefined) {
      return cached;
    }
    const response = await adminApi
      .post('/permissions')
      .send({ type: 'BUTTON', code, name: `探针权限 ${code}` })
      .expect(201);
    const id = (response.body as ResponseEnvelope<PermissionResponseDto>).data
      .id;
    permissionIds.set(code, id);
    return id;
  }

  async function createRoleWithCodes(
    name: string,
    code: string,
    dataScope: string,
    codes: string[],
  ): Promise<RoleResponseDto> {
    const response = await adminApi
      .post('/roles')
      .send({ name, code, dataScope })
      .expect(201);
    const role = (response.body as ResponseEnvelope<RoleResponseDto>).data;
    const permIds: string[] = [];
    for (const permCode of codes) {
      permIds.push(await ensurePermissionId(permCode));
    }
    await adminApi
      .put(`/roles/${role.id}/permissions`)
      .send({ permissionIds: permIds })
      .expect(200);
    return role;
  }

  async function linkUserRole(userId: bigint, roleId: bigint): Promise<void> {
    await prisma.client.sysUserRole.create({
      data: { userId, roleId, createdBy: 0n, updatedBy: 0n },
    });
  }

  async function createAppointment(
    overrides: Partial<Appointment> = {},
  ): Promise<Appointment> {
    return prisma.client.appointment.create({
      data: {
        studentPersonId: personId('S001'),
        mentorProfileId: profileOf('T001').id,
        type: 1,
        status: 0,
        requestedTime: new Date(Date.now() + 7 * DAY_MS),
        topic: '挑战杯选题与打磨',
        questions: '如何把技术方案讲成一个好故事？',
        mode: 1,
        createdBy: 0n,
        updatedBy: 0n,
        ...overrides,
      },
    });
  }

  function expectFieldError(response: { body: unknown }, field: string): void {
    const data = response.body as ResponseEnvelope<{ fields: FieldErrorDto[] }>;
    expect(data.code).toBe(ErrorCode.PARAM_INVALID);
    expect(data.data.fields.some((f) => f.field === field)).toBe(true);
  }

  async function readStatus(id: bigint): Promise<number | undefined> {
    const row = await prisma.client.appointment.findFirst({ where: { id } });
    return row?.status;
  }

  // ── 取消：正例 ────────────────────────────────────────────────────

  it('cancel：0 PENDING → 8 CANCELLED（200）', async () => {
    const appointment = await createAppointment({ status: 0 });
    const response = await api('S001')
      .post(`/appointments/${appointment.id}/cancel`)
      .expect(200);

    const data = (response.body as ResponseEnvelope<AppointmentResponseDto>)
      .data;
    expect(data).toMatchObject({
      id: appointment.id.toString(),
      status: 8,
    });
    expect(await readStatus(appointment.id)).toBe(8);
  });

  it('cancel：1 CONFIRMED → 8 CANCELLED（200）', async () => {
    const appointment = await createAppointment({ status: 1 });
    const response = await api('S001')
      .post(`/appointments/${appointment.id}/cancel`)
      .expect(200);

    const data = (response.body as ResponseEnvelope<AppointmentResponseDto>)
      .data;
    expect(data.status).toBe(8);
    expect(await readStatus(appointment.id)).toBe(8);
  });

  // ── 取消：状态不对 → 409 / 32003 ────────────────────────────────

  it('cancel 在 2 / 3 / 6 / 7 → 各 409 / 32003，库里状态不变', async () => {
    for (const status of [2, 3, 6, 7]) {
      const appointment = await createAppointment({ status });
      const response = await api('S001')
        .post(`/appointments/${appointment.id}/cancel`)
        .expect(409);

      const data = response.body as ResponseEnvelope<null>;
      expect(data.code).toBe(ErrorCode.APPOINTMENT_TRANSITION_INVALID);
      expect(data.message).toBe('当前状态不允许该操作');
      expect(await readStatus(appointment.id)).toBe(status);
    }
  });

  // ── 取消：不是申请人本人 → 403 / 32002 ──────────────────────────

  it('别的学生 S002 取消 S001 的预约 → 403 / 32002', async () => {
    const appointment = await createAppointment();
    const response = await api('S002')
      .post(`/appointments/${appointment.id}/cancel`)
      .expect(403);

    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.APPOINTMENT_FORBIDDEN);
    expect(data.message).toBe('无权访问该预约');
    expect(await readStatus(appointment.id)).toBe(0);
  });

  it('导师 T001 取消学生的预约 → 403 / 32002（不是 10003）', async () => {
    const appointment = await createAppointment();
    const response = await api('T001')
      .post(`/appointments/${appointment.id}/cancel`)
      .expect(403);

    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.APPOINTMENT_FORBIDDEN);
    expect(data.message).toBe('无权访问该预约');
    expect(await readStatus(appointment.id)).toBe(0);
  });

  /**
   * 守卫**顺序**的钉子（返工轮 1 / P2-1）：这条预约**同时**满足「不是我的」
   * 与「状态不可取消」。对调 403 与 409 两条守卫时，只有这条会转红——
   * 单独测「别人的 PENDING」或「自己的 COMPLETED」都区分不出顺序。
   */
  it('别人的、且 status=6 的预约 → 403 / 32002（归属先于状态，不是 32003）', async () => {
    const appointment = await createAppointment({ status: 6 });
    const response = await api('S002')
      .post(`/appointments/${appointment.id}/cancel`)
      .expect(403);

    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.APPOINTMENT_FORBIDDEN);
    expect(data.message).toBe('无权访问该预约');
    expect(await readStatus(appointment.id)).toBe(6);
  });

  // ── 取消：不存在 → 404 / 32001 ──────────────────────────────────

  it('预约不存在 → 404 / 32001', async () => {
    const response = await api('S001')
      .post('/appointments/999999999/cancel')
      .expect(404);

    const data = response.body as ResponseEnvelope<null>;
    expect(data.code).toBe(ErrorCode.APPOINTMENT_NOT_FOUND);
    expect(data.message).toBe('预约不存在');
  });

  // ── 取消：空请求体（任何字段 → 400 / 10001）──────────────────────

  it('cancel 请求体带字段 → 400 / 10001，点名该字段', async () => {
    const appointment = await createAppointment();
    const response = await api('S001')
      .post(`/appointments/${appointment.id}/cancel`)
      .send({ reason: '不想约了' })
      .expect(400);

    expectFieldError(response, 'reason');
    expect(await readStatus(appointment.id)).toBe(0);
  });

  it('路径 id 不是数字（/appointments/abc/cancel）→ 400 / 10001，点名 id', async () => {
    const response = await api('S001')
      .post('/appointments/abc/cancel')
      .expect(400);

    expectFieldError(response, 'id');
  });

  // ── 超时扫描 ────────────────────────────────────────────────────

  it('TTL=0：造一条 PENDING → expireOverdue → expired=1、库里 status=9', async () => {
    await prisma.includingDeleted.appointment.deleteMany({});
    await upsertPendingTtl('0');

    const appointment = await createAppointment({ status: 0 });
    const result = await appointments.expireOverdue();

    expect(result).toEqual({ expired: 1, completed: 0 });
    expect(await readStatus(appointment.id)).toBe(9);
  });

  /**
   * 幂等**自洽**（返工轮 1 / P2-2）：本用例自己清表、自己配 TTL、自己造
   * PENDING 行、自己先跑一次把行推到 9——`-t "幂等"` 单跑也能过，不依赖上一条
   * 用例留下的 `status = 9` 行。
   */
  it('幂等：同一批数据连跑两次，第二次 expired=0，库里不变', async () => {
    await prisma.includingDeleted.appointment.deleteMany({});
    await upsertPendingTtl('0');
    const appointment = await createAppointment({ status: 0 });

    const first = await appointments.expireOverdue();
    expect(first).toEqual({ expired: 1, completed: 0 });
    expect(await readStatus(appointment.id)).toBe(9);

    const second = await appointments.expireOverdue();

    expect(second).toEqual({ expired: 0, completed: 0 });
    const rows = await prisma.client.appointment.findMany({
      where: { status: 9 },
    });
    expect(rows).toHaveLength(1);
    expect(await readStatus(appointment.id)).toBe(9);
  });

  /**
   * TTL 负数 clamp 到 0（返工轮 1 / R34 / P1-1）。不 clamp 时
   * `cutoff = now + 1h`，**刚创建的那条会被扫成终态 9**。
   *
   * `now` 在造数**之前**取：审计扩展按 `new Date()` 写 `createdAt`（DB-06），
   * 所以这条的 `createdAt >= now`；clamp 后 `cutoff = now`，`lt` 不命中。
   */
  it('TTL 配成 -1 → 当 0 处理：刚创建的 PENDING 不动（expired=0）', async () => {
    await prisma.includingDeleted.appointment.deleteMany({});
    await upsertPendingTtl('-1');

    const now = new Date();
    const appointment = await createAppointment({ status: 0 });

    const result = await appointments.expireOverdue(now);

    expect(result).toEqual({ expired: 0, completed: 0 });
    expect(await readStatus(appointment.id)).toBe(0);
  });

  /**
   * R38：`1 CONFIRMED` 的扫描基准是**约定时间 `requestedTime`**，不是 `createdAt`。
   * 下面三条把「已过宽限期 → 扫」「仍在宽限期 → 不动」「createdAt 很老但
   * requestedTime 在未来 → 不动」分开钉住。
   */
  it('CONFIRMED 且 requestedTime 已过宽限期 → 扫成 9', async () => {
    await prisma.includingDeleted.appointment.deleteMany({});
    await upsertPendingTtl('72');
    await upsertConfirmedGrace('24');

    const confirmed = await createAppointment({
      status: 1,
      requestedTime: new Date(Date.now() - 25 * HOUR_MS),
    });

    const result = await appointments.expireOverdue();

    expect(result).toEqual({ expired: 1, completed: 0 });
    expect(await readStatus(confirmed.id)).toBe(9);
  });

  it('CONFIRMED 且 requestedTime 仍在宽限期内（即使 createdAt 很老）→ 不动', async () => {
    await prisma.includingDeleted.appointment.deleteMany({});
    await upsertPendingTtl('72');
    await upsertConfirmedGrace('24');

    // createdAt 是真实当前时间；把 now 推到 100h 后，createdAt 相对 now 就是「很老」。
    const now = new Date(Date.now() + 100 * HOUR_MS);
    // requestedTime = 真实 now + 80h = 相对 now 的 20h 前，仍在 24h 宽限期内。
    const confirmed = await createAppointment({
      status: 1,
      requestedTime: new Date(Date.now() + 80 * HOUR_MS),
    });

    const result = await appointments.expireOverdue(now);

    expect(result).toEqual({ expired: 0, completed: 0 });
    expect(await readStatus(confirmed.id)).toBe(1);
  });

  it('CONFIRMED 且 createdAt 很老但 requestedTime 在未来 → 不动（按 requestedTime 判）', async () => {
    await prisma.includingDeleted.appointment.deleteMany({});
    await upsertPendingTtl('72');
    await upsertConfirmedGrace('24');

    // createdAt = 真实 now（相对推后的 now 已过 100h）；requestedTime 在 now 之后 68h。
    // 若基准错用 createdAt，这条会被扫成 9——本用例就是那个探针。
    const now = new Date(Date.now() + 100 * HOUR_MS);
    const confirmed = await createAppointment({
      status: 1,
      requestedTime: new Date(Date.now() + 168 * HOUR_MS),
    });

    const result = await appointments.expireOverdue(now);

    expect(result).toEqual({ expired: 0, completed: 0 });
    expect(await readStatus(confirmed.id)).toBe(1);
  });

  it('CONFIRMED 幂等：连跑两次，第二次 expired=0', async () => {
    await prisma.includingDeleted.appointment.deleteMany({});
    await upsertPendingTtl('72');
    await upsertConfirmedGrace('0');

    const confirmed = await createAppointment({
      status: 1,
      requestedTime: new Date(Date.now() - HOUR_MS),
    });

    const first = await appointments.expireOverdue();
    expect(first).toEqual({ expired: 1, completed: 0 });
    expect(await readStatus(confirmed.id)).toBe(9);

    const second = await appointments.expireOverdue();
    expect(second).toEqual({ expired: 0, completed: 0 });
    expect(await readStatus(confirmed.id)).toBe(9);
  });

  it('宽限期配成 -1 → 当 0 处理：requestedTime 略在未来的新建 CONFIRMED 不动', async () => {
    await prisma.includingDeleted.appointment.deleteMany({});
    await upsertPendingTtl('72');
    await upsertConfirmedGrace('-1');

    // now 在造数之前取：requestedTime 取 now + 30min，仍在「错误地落到 now+1h」的
    // cutoff 之内——去掉 clamp 这条会被扫成终态 9；clamp 后 cutoff = now，不动。
    const now = new Date();
    const confirmed = await createAppointment({
      status: 1,
      requestedTime: new Date(now.getTime() + 30 * 60 * 1000),
    });

    const result = await appointments.expireOverdue(now);

    expect(result).toEqual({ expired: 0, completed: 0 });
    expect(await readStatus(confirmed.id)).toBe(1);
  });

  it('其余状态（3/4/5/6）一律不动', async () => {
    await prisma.includingDeleted.appointment.deleteMany({});
    await upsertPendingTtl('0');
    await upsertConfirmedGrace('0');

    const past = new Date(Date.now() - 48 * HOUR_MS);
    const rows = new Map<number, Appointment>();
    for (const status of [3, 4, 5, 6]) {
      rows.set(
        status,
        await createAppointment({ status, requestedTime: past }),
      );
    }

    const result = await appointments.expireOverdue();

    expect(result).toEqual({ expired: 0, completed: 0 });
    for (const [status, row] of rows) {
      expect(await readStatus(row.id)).toBe(status);
    }
  });

  it('默认 TTL=72：71 小时不超时、73 小时超时（无 SysConfig 行时走默认值）', async () => {
    await prisma.includingDeleted.appointment.deleteMany({});
    await prisma.includingDeleted.sysConfig.deleteMany({});

    const appointment = await createAppointment({ status: 0 });
    const createdAt = appointment.createdAt;

    // cutoff = (createdAt + 71h) − 72h = createdAt − 1h：createdAt 不早于它 → 不扫
    const notYet = await appointments.expireOverdue(
      new Date(createdAt.getTime() + 71 * HOUR_MS),
    );
    expect(notYet).toEqual({ expired: 0, completed: 0 });
    expect(await readStatus(appointment.id)).toBe(0);

    // cutoff = (createdAt + 73h) − 72h = createdAt + 1h：createdAt 早于它 → 扫
    const overdue = await appointments.expireOverdue(
      new Date(createdAt.getTime() + 73 * HOUR_MS),
    );
    expect(overdue).toEqual({ expired: 1, completed: 0 });
    expect(await readStatus(appointment.id)).toBe(9);
  });

  /** 写（或改）一条 number 型 SysConfig：扫描判据的输入 */
  async function upsertSysConfig(
    code: string,
    name: string,
    value: string,
  ): Promise<void> {
    await prisma.includingDeleted.sysConfig.deleteMany({ where: { code } });
    await prisma.client.sysConfig.create({
      data: {
        code,
        name,
        value,
        valueType: 'number',
        status: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
  }

  /** 写（或改）`appointment.pending_ttl_hours`：`0 PENDING` 判据的输入 */
  async function upsertPendingTtl(value: string): Promise<void> {
    await upsertSysConfig(
      'appointment.pending_ttl_hours',
      '预约待处理有效期（小时）',
      value,
    );
  }

  /** 写（或改）`appointment.confirmed_grace_hours`：`1 CONFIRMED` 判据的输入 */
  async function upsertConfirmedGrace(value: string): Promise<void> {
    await upsertSysConfig(
      'appointment.confirmed_grace_hours',
      '预约已确认宽限期（小时）',
      value,
    );
  }
});

/**
 * 清预约域 + 同步层的残留（照 appointment-handle.e2e-spec.ts 的同名函数）。
 *
 * 走 `includingDeleted`（物理删除）而不是裸 SQL：实体表在 `client` 上的
 * delete 会被 R24 守卫拒掉，`includingDeleted` 才是清库的合法出口。
 * 同步表即使在 `includingDeleted` 上也受 `SYNC_WRITE_FORBIDDEN` 约束，
 * 故包一层 `runWithSyncWrite`（测试造数 / 清库，不是业务写）。
 */
async function clearAppointmentAndSyncTables(
  prisma: PrismaService,
): Promise<void> {
  await prisma.includingDeleted.achievement.deleteMany({});
  await prisma.includingDeleted.assessmentAppeal.deleteMany({});
  await prisma.includingDeleted.assessment.deleteMany({});
  await prisma.includingDeleted.studentReview.deleteMany({});
  await prisma.includingDeleted.guidanceMaterial.deleteMany({});
  await prisma.includingDeleted.guidanceRecord.deleteMany({});
  await prisma.includingDeleted.appointmentMaterial.deleteMany({});
  await prisma.includingDeleted.appointment.deleteMany({});
  await prisma.includingDeleted.mentorTimeSlot.deleteMany({});
  await prisma.includingDeleted.mentorApplicationMaterial.deleteMany({});
  await prisma.includingDeleted.mentorApplication.deleteMany({});
  await prisma.includingDeleted.mentorProfile.deleteMany({});
  await runWithSyncWrite(() =>
    prisma.includingDeleted.syncPerson.deleteMany({}),
  );
  await runWithSyncWrite(() =>
    prisma.includingDeleted.syncOrgUnit.deleteMany({}),
  );
}
