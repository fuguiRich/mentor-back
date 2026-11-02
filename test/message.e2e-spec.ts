import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { runWithSyncWrite } from '../src/infra/prisma/sync-write-scope';
import { ErrorCode } from '../src/common/constants/error-code';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import { currentPeriod } from '../src/modules/assessment/assessment.constants';
import type { MessageListResponseDto } from '../src/modules/message/dto/message-response.dto';
import type { WorkProgressResponseDto } from '../src/modules/message/dto/work-progress.dto';
import {
  authedAgent,
  clearBusinessTables,
  clearModuleTables,
  loginAs,
  seedSuperAdmin,
  seedUser,
  type E2eApi,
} from './e2e-helpers';

const SYNCED_AT = new Date('2026-10-27T00:00:00.000Z');

/**
 * §4.5 工作进度 / 提醒 / 消息（P5 Task 58）。
 *
 * 三种提醒各一条：预约待确认、逾期未填记录、考核待处理。提醒只发给
 * 「该类型计数 > 0」的导师；没有 SysUser 的计入 skipped。
 */
describe('工作进度与提醒（P5 Task 58 / §4.5）(e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const agents = new Map<string, E2eApi>();
  const permissionIds = new Map<string, bigint>();
  const deptIds = new Map<string, bigint>();
  const people = new Map<string, bigint>();
  const profiles = new Map<string, bigint>();
  const userIds = new Map<string, bigint>();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);

    await clearMessageTables(prisma);
    await clearBusinessTables(prisma);
    await clearModuleTables(prisma);

    await seedSuperAdmin(prisma);
    const rootDept = await prisma.client.sysDept.findFirst({
      where: { name: '总公司' },
    });
    if (rootDept === null) {
      throw new Error('seedSuperAdmin 未种出「总公司」部门');
    }
    deptIds.set('root', rootDept.id);
    deptIds.set('A', await createDept('消息 A 学院', rootDept.id));
    deptIds.set('B', await createDept('消息 B 学院', rootDept.id));

    const orgA = await createOrg('ORG-MSG-A', '消息 A 组织', dept('A'));
    const orgB = await createOrg('ORG-MSG-B', '消息 B 组织', dept('B'));

    for (const [login, orgUnitId] of [
      ['msg-a1', orgA],
      ['msg-b1', orgB],
    ] as const) {
      const person = await runWithSyncWrite(() =>
        prisma.client.syncPerson.create({
          data: {
            login,
            realName: login,
            personType: 'internalMentor',
            orgUnitId,
            syncedAt: SYNCED_AT,
            createdBy: 0n,
            updatedBy: 0n,
          },
        }),
      );
      people.set(login, person.id);
    }

    profiles.set('a1', await createProfile('msg-a1'));
    profiles.set('b1', await createProfile('msg-b1'));

    // A1：1 条待确认 + 1 条逾期未填记录；B1：1 条待确认
    await createAppointment('msg-a1', 'a1', 0, 1);
    await createAppointment('msg-a1', 'a1', 1, 2, true);
    await createAppointment('msg-b1', 'b1', 0, 3);
    await prisma.client.assessment.create({
      data: {
        mentorId: profiles.get('a1') as bigint,
        period: currentPeriod(),
        status: 0,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });

    const collegeRole = await createRole(
      '消息学院管理员',
      'msg_college',
      'deptAndChildren',
      ['work:progress', 'reminder:send', 'message:list'],
    );
    const scRole = await createRole('消息双创学院', 'msg_sc', 'all', [
      'work:progress',
      'reminder:send',
      'message:list',
    ]);
    const mentorRole = await createRole('消息导师', 'msg_mentor', 'self', [
      'message:list',
    ]);

    for (const [username, roleId, deptKey] of [
      ['msg-college-a', collegeRole, 'A'],
      ['msg-sc', scRole, 'root'],
      ['msg-a1', mentorRole, 'A'],
      ['msg-b1', mentorRole, 'B'],
    ] as const) {
      const user = await seedUser(prisma, { username, deptId: dept(deptKey) });
      userIds.set(username, user.userId);
      await prisma.client.sysUserRole.create({
        data: { userId: user.userId, roleId, createdBy: 0n, updatedBy: 0n },
      });
      const tokens = await loginAs(app, username, 'Passw0rd!');
      agents.set(username, authedAgent(app, tokens.accessToken));
    }
  });

  afterAll(async () => {
    try {
      if (prisma !== undefined) {
        await clearMessageTables(prisma);
        await clearBusinessTables(prisma);
        await clearModuleTables(prisma);
      }
    } finally {
      if (app !== undefined) {
        await app.close();
      }
    }
  });

  function dept(key: string): bigint {
    const id = deptIds.get(key);
    if (id === undefined) {
      throw new Error(`没有 ${key} 部门`);
    }
    return id;
  }

  function personOf(login: string): bigint {
    const id = people.get(login);
    if (id === undefined) {
      throw new Error(`没有 ${login} 的 SyncPerson`);
    }
    return id;
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

  async function createProfile(login: string): Promise<bigint> {
    const row = await prisma.client.mentorProfile.create({
      data: {
        personId: personOf(login),
        researchFields: [],
        status: 2,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    return row.id;
  }

  async function createAppointment(
    studentLogin: string,
    mentorKey: string,
    status: number,
    day: number,
    overdue = false,
  ): Promise<bigint> {
    const row = await prisma.client.appointment.create({
      data: {
        studentPersonId: personOf(studentLogin),
        mentorProfileId: profiles.get(mentorKey) as bigint,
        type: 1,
        status,
        requestedTime: overdue
          ? new Date(Date.now() - 86_400_000)
          : new Date(`2026-06-0${day}T02:00:00.000Z`),
        topic: `消息夹具 ${day}`,
        questions: '消息夹具',
        mode: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    return row.id;
  }

  async function ensurePermissionId(code: string): Promise<bigint> {
    const cached = permissionIds.get(code);
    if (cached !== undefined) {
      return cached;
    }
    const row = await prisma.client.sysPermission.create({
      data: {
        type: 'BUTTON',
        code,
        name: `P5 ${code}`,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    permissionIds.set(code, row.id);
    return row.id;
  }

  async function createRole(
    name: string,
    code: string,
    dataScope: string,
    permCodes: readonly string[],
  ): Promise<bigint> {
    const role = await prisma.client.sysRole.create({
      data: { name, code, dataScope, createdBy: 0n, updatedBy: 0n },
    });
    for (const permCode of permCodes) {
      await prisma.client.sysRolePermission.create({
        data: {
          roleId: role.id,
          permissionId: await ensurePermissionId(permCode),
          createdBy: 0n,
          updatedBy: 0n,
        },
      });
    }
    return role.id;
  }

  it('判据 1：学院管理员看本院工作进度', async () => {
    const response = await api('msg-college-a')
      .get('/work-progress')
      .expect(200);
    const data = (response.body as ResponseEnvelope<WorkProgressResponseDto>)
      .data;

    expect(data).toMatchObject({
      totalMentors: 1,
      pendingAppointments: 1,
      missingRecords: 1,
      pendingAssessments: 1,
    });
    expect(data.mentors).toHaveLength(1);
    expect(data.mentors[0]).toMatchObject({
      mentorProfileId: profiles.get('a1')?.toString(),
      pendingAppointments: 1,
      missingRecords: 1,
      pendingAssessments: 1,
    });
  });

  it('判据 2：双创学院看全校工作进度', async () => {
    const response = await api('msg-sc').get('/work-progress').expect(200);
    const data = (response.body as ResponseEnvelope<WorkProgressResponseDto>)
      .data;

    expect(data).toMatchObject({
      totalMentors: 2,
      pendingAppointments: 2,
      missingRecords: 1,
      pendingAssessments: 1,
    });
  });

  it('判据 3：发预约待处理提醒 → 导师收到一条未读消息', async () => {
    const response = await api('msg-college-a')
      .post('/reminders')
      .send({ type: 'pending-appointments' })
      .expect(201);
    expect(
      (response.body as ResponseEnvelope<{ sent: number; skipped: number }>)
        .data,
    ).toEqual({ sent: 1, skipped: 0 });

    const message = await prisma.client.message.findFirst({
      where: { recipientUserId: userIds.get('msg-a1') },
    });
    expect(message).toMatchObject({
      type: 1,
      title: '预约待处理提醒',
      content: '您有 1 条预约待确认，请及时处理。',
      bizType: 'MentorProfile',
      bizId: profiles.get('a1')?.toString(),
      readAt: null,
    });
  });

  it('判据 4：发记录未填提醒 → 文案与计数正确', async () => {
    await api('msg-college-a')
      .post('/reminders')
      .send({ type: 'record-missing' })
      .expect(201);
    const message = await prisma.client.message.findFirst({
      where: {
        recipientUserId: userIds.get('msg-a1'),
        type: 2,
      },
    });
    expect(message).toMatchObject({
      title: '指导记录待填写提醒',
      content: '您有 1 条已确认预约尚未填写指导记录，请及时补填。',
    });
  });

  it('判据 5：发考核待处理提醒 → 文案含当前学期', async () => {
    await api('msg-college-a')
      .post('/reminders')
      .send({ type: 'assessment-pending' })
      .expect(201);
    const message = await prisma.client.message.findFirst({
      where: {
        recipientUserId: userIds.get('msg-a1'),
        type: 3,
      },
    });
    expect(message).toMatchObject({
      title: '考核待处理提醒',
      content: `您在 ${currentPeriod()} 的考核尚未完成，请及时处理。`,
    });
  });

  it('判据 6：导师只看到自己的消息，未读数正确', async () => {
    const response = await api('msg-a1').get('/messages').expect(200);
    const data = (response.body as ResponseEnvelope<MessageListResponseDto>)
      .data;

    expect(data.total).toBe(3);
    expect(data.unread).toBe(3);
    expect(data.list.map((item) => item.type)).toEqual([3, 2, 1]);

    const b1 = await api('msg-b1').get('/messages').expect(200);
    expect(
      (b1.body as ResponseEnvelope<MessageListResponseDto>).data.total,
    ).toBe(0);
  });

  it('判据 7：标记已读 → readAt 非空；再读一次幂等', async () => {
    const list = await api('msg-a1').get('/messages').expect(200);
    const first = (list.body as ResponseEnvelope<MessageListResponseDto>).data
      .list[0];

    const response = await api('msg-a1')
      .patch(`/messages/${first.id}/read`)
      .expect(200);
    const data = (response.body as ResponseEnvelope<{ readAt: string }>).data;
    expect(data.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const again = await api('msg-a1')
      .patch(`/messages/${first.id}/read`)
      .expect(200);
    expect(
      (again.body as ResponseEnvelope<{ readAt: string }>).data.readAt,
    ).toBe(data.readAt);

    const unread = await api('msg-a1')
      .get('/messages')
      .query({ read: 0 })
      .expect(200);
    expect(
      (unread.body as ResponseEnvelope<MessageListResponseDto>).data.total,
    ).toBe(2);
  });

  it('判据 8：标记别人的消息 → 404 / 38001', async () => {
    const list = await api('msg-a1').get('/messages').expect(200);
    const first = (list.body as ResponseEnvelope<MessageListResponseDto>).data
      .list[0];
    const response = await api('msg-b1')
      .patch(`/messages/${first.id}/read`)
      .expect(404);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.MESSAGE_NOT_FOUND,
    );
  });

  it('判据 9：read-all 只清自己的未读，第二次 updated = 0', async () => {
    const response = await api('msg-a1').post('/messages/read-all').expect(201);
    expect(
      (response.body as ResponseEnvelope<{ updated: number }>).data,
    ).toEqual({ updated: 2 });

    const again = await api('msg-a1').post('/messages/read-all').expect(201);
    expect((again.body as ResponseEnvelope<{ updated: number }>).data).toEqual({
      updated: 0,
    });
  });

  it('判据 10：学院管理员给外院导师发提醒 → 403 / 10003', async () => {
    const response = await api('msg-college-a')
      .post('/reminders')
      .send({
        type: 'pending-appointments',
        mentorProfileIds: [profiles.get('b1')?.toString()],
      })
      .expect(403);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });
});

async function clearMessageTables(prisma: PrismaService): Promise<void> {
  await prisma.includingDeleted.message.deleteMany({});
  await prisma.includingDeleted.archiveItem.deleteMany({});
  await prisma.includingDeleted.assessmentAppeal.deleteMany({});
  await prisma.includingDeleted.assessment.deleteMany({});
  await prisma.includingDeleted.achievement.deleteMany({});
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
