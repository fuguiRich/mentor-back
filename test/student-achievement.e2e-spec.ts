import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { runWithSyncWrite } from '../src/infra/prisma/sync-write-scope';
import { ErrorCode } from '../src/common/constants/error-code';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import { currentPeriod } from '../src/modules/assessment/assessment.constants';
import type { AssessmentResponseDto } from '../src/modules/assessment/dto/assessment-response.dto';
import type { FileResponseDto } from '../src/modules/file/dto/file-response.dto';
import type {
  StudentAchievementListResponseDto,
  StudentAchievementResponseDto,
} from '../src/modules/student-achievement/dto/student-achievement-response.dto';
import type { StudentOptionListResponseDto } from '../src/modules/student-achievement/dto/student-option.dto';
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
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const PERIOD = currentPeriod();
const AWARDED_AT = PERIOD.endsWith('-1')
  ? `${PERIOD.slice(0, 4)}-05-01`
  : `${PERIOD.slice(0, 4)}-11-01`;

/**
 * §5.4 学生成果关联（P5 Task 59）。
 *
 * 关联 = 人工（P5-R3）：学院管理员把学生成果挂到导师名下；同事务生成一条
 * 导师 `Achievement`（考核指标自动计入）与一条归档条目（`core=0`）。
 */
describe('学生成果关联（P5 Task 59 / §5.4）(e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const agents = new Map<string, E2eApi>();
  const permissionIds = new Map<string, bigint>();
  const deptIds = new Map<string, bigint>();
  const people = new Map<string, bigint>();
  const profiles = new Map<string, bigint>();

  let unlinkedId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);

    await clearStudentAchievementTables(prisma);
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
    deptIds.set('A', await createDept('成果 A 学院', rootDept.id));
    deptIds.set('B', await createDept('成果 B 学院', rootDept.id));

    const orgA = await createOrg('ORG-SA-A', '成果 A 组织', dept('A'));
    const orgB = await createOrg('ORG-SA-B', '成果 B 组织', dept('B'));

    for (const [login, personType, orgUnitId] of [
      ['sa-mentor-a', 'internalMentor', orgA],
      ['sa-mentor-b', 'internalMentor', orgB],
      ['sa-student-a', 'student', orgA],
      ['sa-student-b', 'student', orgB],
    ] as const) {
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
      people.set(login, person.id);
    }
    profiles.set('a', await createProfile('sa-mentor-a'));
    profiles.set('b', await createProfile('sa-mentor-b'));

    const collegeRole = await createRole(
      '成果学院管理员',
      'sa_college',
      'deptAndChildren',
      [
        'student-achievement:manage',
        'student-achievement:list',
        // 判据 13 需要先 POST /files 传佐证
        'file:create',
        'assessment:evaluate',
        'assessment:list',
      ],
    );
    const scRole = await createRole('成果双创学院', 'sa_sc', 'all', [
      'student-achievement:list',
      'assessment:evaluate',
      'assessment:list',
    ]);
    const mentorRole = await createRole('成果导师', 'sa_mentor', 'self', [
      'student-achievement:list',
    ]);
    const studentRole = await createRole('成果学生', 'sa_student', 'self', [
      'student-achievement:list',
    ]);

    for (const [username, roleId, deptKey] of [
      ['sa-college-a', collegeRole, 'A'],
      ['sa-sc', scRole, 'root'],
      ['sa-mentor-a', mentorRole, 'A'],
      ['sa-student-a', studentRole, 'A'],
    ] as const) {
      const user = await seedUser(prisma, { username, deptId: dept(deptKey) });
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
        await clearStudentAchievementTables(prisma);
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

  function body(overrides: Record<string, unknown> = {}) {
    return {
      studentPersonId: personOf('sa-student-a').toString(),
      type: 1,
      title: '省级竞赛金奖',
      level: 2,
      awardedAt: AWARDED_AT,
      ...overrides,
    };
  }

  it('判据 1：学院建本院学生成果（未关联）→ 201、mentorId 为 null', async () => {
    const response = await api('sa-college-a')
      .post('/student-achievements')
      .send(body())
      .expect(201);
    const data = (
      response.body as ResponseEnvelope<StudentAchievementResponseDto>
    ).data;
    unlinkedId = data.id;

    expect(data).toMatchObject({
      studentPersonId: personOf('sa-student-a').toString(),
      studentName: 'sa-student-a',
      mentorProfileId: null,
      achievementId: null,
      deptId: dept('A').toString(),
      type: 1,
      title: '省级竞赛金奖',
      level: 2,
      awardedAt: AWARDED_AT,
      linkedAt: null,
    });
  });

  it('判据 2：学院建外院学生成果 → 403 / 10003', async () => {
    const response = await api('sa-college-a')
      .post('/student-achievements')
      .send(
        body({
          studentPersonId: personOf('sa-student-b').toString(),
        }),
      )
      .expect(403);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  it('判据 3：建成果时直接关联导师 → 生成导师成果与归档', async () => {
    const response = await api('sa-college-a')
      .post('/student-achievements')
      .send(
        body({
          mentorProfileId: profiles.get('a')?.toString(),
        }),
      )
      .expect(201);
    const data = (
      response.body as ResponseEnvelope<StudentAchievementResponseDto>
    ).data;

    expect(data).toMatchObject({
      mentorProfileId: profiles.get('a')?.toString(),
    });
    expect(data.linkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.achievementId).not.toBeNull();

    const achievement = await prisma.client.achievement.findFirst({
      where: { id: BigInt(data.achievementId as string) },
    });
    expect(achievement).toMatchObject({
      mentorId: profiles.get('a'),
      type: 1,
      title: '省级竞赛金奖',
      level: 2,
      description: '学生双创成果关联',
    });

    const archive = await prisma.client.archiveItem.findFirst({
      where: { targetType: 'StudentAchievement', targetId: data.id },
    });
    expect(archive).toMatchObject({
      category: 'achievement',
      core: 0,
      mentorId: profiles.get('a'),
      deptId: dept('A'),
    });
    expect(archive?.retentionUntil).not.toBeNull();
  });

  it('判据 4：PATCH link 未关联成果 → 生成第二条导师成果', async () => {
    const response = await api('sa-college-a')
      .patch(`/student-achievements/${unlinkedId}/link`)
      .send({ mentorProfileId: profiles.get('a')?.toString() })
      .expect(200);
    const data = (
      response.body as ResponseEnvelope<StudentAchievementResponseDto>
    ).data;
    expect(data.mentorProfileId).toBe(profiles.get('a')?.toString());
    expect(data.achievementId).not.toBeNull();

    const count = await prisma.client.achievement.count({
      where: { mentorId: profiles.get('a') },
    });
    expect(count).toBe(2);
  });

  it('判据 5：重复 link → 409 / 39002', async () => {
    const response = await api('sa-college-a')
      .patch(`/student-achievements/${unlinkedId}/link`)
      .send({ mentorProfileId: profiles.get('a')?.toString() })
      .expect(409);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.STUDENT_ACHIEVEMENT_ALREADY_LINKED,
    );
  });

  it('判据 6：关联不存在 / 未生效的导师 → 404 / 31102', async () => {
    const created = await api('sa-college-a')
      .post('/student-achievements')
      .send(body({ title: '待关联成果' }))
      .expect(201);
    const id = (created.body as ResponseEnvelope<StudentAchievementResponseDto>)
      .data.id;
    const response = await api('sa-college-a')
      .patch(`/student-achievements/${id}/link`)
      .send({ mentorProfileId: '999999' })
      .expect(404);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.MENTOR_PROFILE_NOT_FOUND,
    );
  });

  it('判据 7：双创学院检索全部，按 student / mentor / linked 过滤', async () => {
    const all = await api('sa-sc').get('/student-achievements').expect(200);
    expect(
      (all.body as ResponseEnvelope<StudentAchievementListResponseDto>).data
        .total,
    ).toBe(3);

    const byStudent = await api('sa-sc')
      .get('/student-achievements')
      .query({ studentPersonId: personOf('sa-student-a').toString() })
      .expect(200);
    expect(
      (byStudent.body as ResponseEnvelope<StudentAchievementListResponseDto>)
        .data.total,
    ).toBe(3);

    const byMentor = await api('sa-sc')
      .get('/student-achievements')
      .query({ mentorId: profiles.get('a')?.toString() })
      .expect(200);
    expect(
      (byMentor.body as ResponseEnvelope<StudentAchievementListResponseDto>)
        .data.total,
    ).toBe(2);

    const unlinked = await api('sa-sc')
      .get('/student-achievements')
      .query({ linked: 0 })
      .expect(200);
    expect(
      (unlinked.body as ResponseEnvelope<StudentAchievementListResponseDto>)
        .data.total,
    ).toBe(1);
  });

  it('判据 8：导师只看到关联到自己的成果', async () => {
    const response = await api('sa-mentor-a')
      .get('/student-achievements')
      .expect(200);
    const data = (
      response.body as ResponseEnvelope<StudentAchievementListResponseDto>
    ).data;
    expect(data.total).toBe(2);
    for (const row of data.list) {
      expect(row.mentorProfileId).toBe(profiles.get('a')?.toString());
    }
  });

  it('判据 9：学生只看到自己的成果（实践学时档案数据源）', async () => {
    const response = await api('sa-student-a')
      .get('/student-achievements')
      .expect(200);
    const data = (
      response.body as ResponseEnvelope<StudentAchievementListResponseDto>
    ).data;
    expect(data.total).toBe(3);
    for (const row of data.list) {
      expect(row.studentPersonId).toBe(personOf('sa-student-a').toString());
    }
  });

  it('判据 10：关联的成果计入导师考核 achievementCount', async () => {
    const response = await api('sa-sc')
      .post('/assessments')
      .send({ mentorId: profiles.get('a')?.toString(), period: PERIOD })
      .expect(201);
    const data = (response.body as ResponseEnvelope<AssessmentResponseDto>)
      .data;
    expect(data.metrics.achievementCount).toBe(2);
  });

  it('判据 11：删除已关联成果 → 导师成果与归档同时软删', async () => {
    const before = (
      await api('sa-sc')
        .get('/student-achievements')
        .query({ mentorId: profiles.get('a')?.toString() })
        .expect(200)
    ).body as ResponseEnvelope<StudentAchievementListResponseDto>;
    const target = before.data.list.find((row) => row.id === unlinkedId);
    if (target === undefined) {
      throw new Error('判据 4 的成果不见了');
    }
    const achievementId = BigInt(target.achievementId as string);

    await api('sa-college-a')
      .delete(`/student-achievements/${unlinkedId}`)
      .expect(200);

    const studentRow = await prisma.client.studentAchievement.findFirst({
      where: { id: BigInt(unlinkedId) },
    });
    expect(studentRow).toBeNull();
    const achievement = await prisma.client.achievement.findFirst({
      where: { id: achievementId },
    });
    expect(achievement).toBeNull();
    const archive = await prisma.client.archiveItem.findFirst({
      where: { targetType: 'StudentAchievement', targetId: unlinkedId },
    });
    expect(archive).toBeNull();
  });

  it('判据 12：学生调 POST → 403 / 10003', async () => {
    const response = await api('sa-student-a')
      .post('/student-achievements')
      .send(body({ title: '越权成果' }))
      .expect(403);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  it('判据 13：成果佐证可预览下载；无佐证 404；无关导师 403', async () => {
    const upload = await api('sa-college-a')
      .post('/files')
      .attach('files', PDF, {
        filename: '成果佐证.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    const file = (upload.body as ResponseEnvelope<FileResponseDto[]>).data[0];

    const created = await api('sa-college-a')
      .post('/student-achievements')
      .send(body({ title: '带佐证的学生成果', proofFileId: file.id }))
      .expect(201);
    const id = (created.body as ResponseEnvelope<StudentAchievementResponseDto>)
      .data.id;

    const preview = await api('sa-student-a')
      .get(`/student-achievements/${id}/proof/preview`)
      .expect(200);
    expect(preview.headers['content-disposition']).toContain('inline');
    expect(preview.headers['content-type']).toBe('application/pdf');
    expect(Buffer.compare(preview.body as Buffer, PDF)).toBe(0);

    const download = await api('sa-student-a')
      .get(`/student-achievements/${id}/proof/download`)
      .expect(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(Buffer.compare(download.body as Buffer, PDF)).toBe(0);

    // 无佐证：新建一条不带 proofFileId 的成果
    const noProofCreated = await api('sa-college-a')
      .post('/student-achievements')
      .send(body({ title: '无佐证的学生成果' }))
      .expect(201);
    const noProofId = (
      noProofCreated.body as ResponseEnvelope<StudentAchievementResponseDto>
    ).data.id;
    const noProof = await api('sa-student-a')
      .get(`/student-achievements/${noProofId}/proof/preview`)
      .expect(404);
    expect((noProof.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FILE_NOT_FOUND,
    );

    // 无关导师（self 范围，且成果未关联任何导师）→ 403
    await api('sa-mentor-a')
      .get(`/student-achievements/${id}/proof/preview`)
      .expect(403);
  });

  it('判据 14：学生下拉目录——学院管理员可按姓名检索本院学生；跨院 403；学生为空', async () => {
    const response = await api('sa-college-a')
      .get('/student-achievements/students')
      .query({ keyword: 'sa-student-a' })
      .expect(200);
    const data = (
      response.body as ResponseEnvelope<StudentOptionListResponseDto>
    ).data;
    expect(data.total).toBe(1);
    expect(data.list[0]).toMatchObject({
      id: personOf('sa-student-a').toString(),
      login: 'sa-student-a',
      realName: 'sa-student-a',
      deptId: dept('A').toString(),
    });

    const crossDept = await api('sa-college-a')
      .get('/student-achievements/students')
      .query({ deptId: dept('B').toString() })
      .expect(403);
    expect((crossDept.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );

    const self = await api('sa-student-a')
      .get('/student-achievements/students')
      .expect(200);
    expect(
      (self.body as ResponseEnvelope<StudentOptionListResponseDto>).data.total,
    ).toBe(0);
  });
});

async function clearStudentAchievementTables(
  prisma: PrismaService,
): Promise<void> {
  await prisma.includingDeleted.studentAchievement.deleteMany({});
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
