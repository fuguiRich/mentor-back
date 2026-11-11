import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { runWithSyncWrite } from '../src/infra/prisma/sync-write-scope';
import { ErrorCode } from '../src/common/constants/error-code';
import type { ResponseEnvelope } from '../src/common/interceptors/response.interceptor';
import type {
  ArchiveListResponseDto,
  ArchiveResponseDto,
} from '../src/modules/archive/dto/archive-response.dto';
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
const CURRENT_YEAR = String(new Date().getUTCFullYear());
const TIME_ZONE = process.env.APP_TIMEZONE || 'Asia/Shanghai';
const DEFAULT_RETENTION_DAYS = 1825;

/**
 * 归档（P4 Task 52 / §4.7）。
 *
 * 判据覆盖三类写入：两个审核通过点的**自动归档**（同事务、快照 mentorId /
 * deptId）、管理员**手工归档**（core=0 + 保留期），以及检索的**部门范围**。
 *
 * 自动归档的两条路径都走真实接口（sc-review / final-review），不直接调仓储：
 * 判据要证明的是「审核通过时归档真的落库」，绕过审核就等于绕过被验的东西。
 */
describe('归档（P4 Task 52 / §4.7）(e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const agents = new Map<string, E2eApi>();
  const permissionIds = new Map<string, bigint>();
  const deptIds = new Map<string, bigint>();
  const people = new Map<string, bigint>();
  const profiles = new Map<string, bigint>();

  let appAId: bigint;
  let appBId: bigint;
  let assessmentAId: bigint;
  let manualAId: string;
  let manualBId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);

    await clearArchiveTables(prisma);
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
    deptIds.set('A', await createDept('归档 A 学院', rootDept.id));
    deptIds.set('B', await createDept('归档 B 学院', rootDept.id));

    const orgA = await createOrg('ORG-ARC-A', '归档 A 组织', dept('A'));
    const orgB = await createOrg('ORG-ARC-B', '归档 B 组织', dept('B'));

    for (const [login, personType, orgUnitId] of [
      ['mentor-a1', 'internalMentor', orgA],
      ['mentor-b1', 'internalMentor', orgB],
      ['arc-student', 'student', orgA],
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

    profiles.set('a1', await createProfile('mentor-a1'));
    profiles.set('b1', await createProfile('mentor-b1'));

    const scRole = await createRole('归档双创学院', 'arc_sc', 'all', [
      'archive:list',
      'archive:manage',
      'file:create',
      'mentor-application:review-sc',
      'assessment:finalize',
    ]);
    const collegeRole = await createRole(
      '归档学院管理员',
      'arc_college',
      'deptAndChildren',
      ['archive:list'],
    );
    const mentorRole = await createRole('归档导师', 'arc_mentor', 'self', [
      'archive:list',
    ]);
    const studentRole = await createRole('归档学生', 'arc_student', 'self', []);

    for (const [username, roleId, deptKey] of [
      ['arc-sc', scRole, 'root'],
      ['arc-college-a', collegeRole, 'A'],
      ['mentor-a1', mentorRole, 'A'],
      ['arc-student', studentRole, 'A'],
    ] as const) {
      const user = await seedUser(prisma, { username, deptId: dept(deptKey) });
      await prisma.client.sysUserRole.create({
        data: { userId: user.userId, roleId, createdBy: 0n, updatedBy: 0n },
      });
      const tokens = await loginAs(app, username, 'Passw0rd!');
      agents.set(username, authedAgent(app, tokens.accessToken));
    }

    // 两张待终审的入驻申请（4 SC_REVIEWING）：sc-review approve 即可触发归档
    appAId = await createApplication('mentor-a1', profiles.get('a1') as bigint);
    appBId = await createApplication('mentor-b1', profiles.get('b1') as bigint);
    assessmentAId = await createAssessment(profiles.get('a1') as bigint);
  });

  afterAll(async () => {
    try {
      if (prisma !== undefined) {
        await clearArchiveTables(prisma);
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

  async function createApplication(
    login: string,
    profileId: bigint,
  ): Promise<bigint> {
    const row = await prisma.client.mentorApplication.create({
      data: {
        type: 1,
        applicantId: personOf(login),
        profileId,
        snapshot: {},
        status: 4,
        submittedAt: new Date(),
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    return row.id;
  }

  async function createAssessment(mentorId: bigint): Promise<bigint> {
    const row = await prisma.client.assessment.create({
      data: {
        mentorId,
        period: CURRENT_YEAR,
        status: 1,
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
        name: `P4 ${code}`,
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

  function dateOnlyInZone(now: Date, offsetDays: number): string {
    const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(now)
      .split('-')
      .map((part) => Number(part));
    return new Date(Date.UTC(year, month - 1, day + offsetDays))
      .toISOString()
      .slice(0, 10);
  }

  /** 检索用的日期是 UTC 日历日（与统计域 R70 同一口径） */
  function utcDate(offsetDays: number): string {
    const now = new Date();
    return new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + offsetDays,
      ),
    )
      .toISOString()
      .slice(0, 10);
  }

  /** 造一条手工归档，并把保留期改成指定日期（默认保留期是 1825 天后） */
  async function createManualArchive(
    targetId: string,
    title: string,
    retentionUntil: string,
  ): Promise<string> {
    const created = await api('arc-sc')
      .post('/archives')
      .send({
        targetType: 'Other',
        targetId,
        title,
        category: 'other',
        mentorId: profiles.get('a1')?.toString(),
        deptId: dept('A').toString(),
      })
      .expect(201);
    const id = (created.body as ResponseEnvelope<ArchiveResponseDto>).data.id;
    await api('arc-sc')
      .patch(`/archives/${id}`)
      .send({ retentionUntil })
      .expect(200);
    return id;
  }

  it('判据 1：入驻申请终审通过 → 自动归档 core=1、无保留期、快照导师与学院', async () => {
    await api('arc-sc')
      .post(`/mentor-applications/${appAId.toString()}/sc-review`)
      .send({ decision: 'approve', comment: '同意入驻' })
      .expect(200);
    await api('arc-sc')
      .post(`/mentor-applications/${appBId.toString()}/sc-review`)
      .send({ decision: 'approve', comment: '同意入驻' })
      .expect(200);

    const rows = await prisma.client.archiveItem.findMany({
      where: { targetType: 'MentorApplication' },
      orderBy: { id: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      targetId: appAId.toString(),
      category: 'mentor-application',
      core: 1,
      mentorId: profiles.get('a1'),
      deptId: dept('A'),
      retentionUntil: null,
    });
    expect(rows[1]).toMatchObject({
      targetId: appBId.toString(),
      mentorId: profiles.get('b1'),
      deptId: dept('B'),
    });
  });

  it('判据 2：考核终评通过 → 自动归档并快照导师所在学院', async () => {
    await api('arc-sc')
      .post(`/assessments/${assessmentAId.toString()}/final-review`)
      .send({ decision: 'approve', grade: 1, comment: '同意' })
      .expect(200);

    const row = await prisma.client.archiveItem.findFirst({
      where: { targetType: 'Assessment', targetId: assessmentAId.toString() },
    });
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      category: 'assessment',
      core: 1,
      mentorId: profiles.get('a1'),
      deptId: dept('A'),
      retentionUntil: null,
    });
  });

  it('判据 3：同一申请重复终审 → 409 且归档仍只有一条（幂等）', async () => {
    const before = await prisma.client.archiveItem.count({
      where: { targetType: 'MentorApplication', targetId: appAId.toString() },
    });
    const response = await api('arc-sc')
      .post(`/mentor-applications/${appAId.toString()}/sc-review`)
      .send({ decision: 'approve', comment: '再审一次' })
      .expect(409);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.MENTOR_APPLICATION_TRANSITION_INVALID,
    );
    const after = await prisma.client.archiveItem.count({
      where: { targetType: 'MentorApplication', targetId: appAId.toString() },
    });
    expect(after).toBe(before);
  });

  it('判据 4：手工归档 core=0，保留期 = 今天 + 1825 天', async () => {
    const response = await api('arc-sc')
      .post('/archives')
      .send({
        targetType: 'Achievement',
        targetId: '9001',
        title: '2026 省级竞赛成果',
        category: 'achievement',
        mentorId: profiles.get('a1')?.toString(),
        deptId: dept('A').toString(),
        summary: '手工归档的非核心材料',
      })
      .expect(201);
    const data = (response.body as ResponseEnvelope<ArchiveResponseDto>).data;

    manualAId = data.id;
    expect(data).toMatchObject({
      targetType: 'Achievement',
      targetId: '9001',
      title: '2026 省级竞赛成果',
      category: 'achievement',
      core: 0,
      mentorId: profiles.get('a1')?.toString(),
      deptId: dept('A').toString(),
      summary: '手工归档的非核心材料',
      retentionUntil: dateOnlyInZone(new Date(), DEFAULT_RETENTION_DAYS),
    });
    expect(data.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('判据 4b：归档附件可上传 / 预览 / 下载 / 清空；StudentAchievement 可作为目标类型', async () => {
    const upload = await api('arc-sc')
      .post('/files')
      .attach('files', PDF, {
        filename: '归档佐证.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    const file = (upload.body as ResponseEnvelope<{ id: string }[]>).data[0];

    const created = await api('arc-sc')
      .post('/archives')
      .send({
        targetType: 'StudentAchievement',
        targetId: 'attach-1',
        title: '带附件的学生成果归档',
        category: 'other',
        fileIds: [file.id],
      })
      .expect(201);
    const data = (created.body as ResponseEnvelope<ArchiveResponseDto>).data;
    expect(data.fileIds).toEqual([file.id]);
    expect(data.files).toEqual([
      {
        id: file.id,
        originName: '归档佐证.pdf',
        mimeType: 'application/pdf',
        size: PDF.length,
      },
    ]);

    const preview = await api('arc-sc')
      .get(`/archives/${data.id}/files/${file.id}/preview`)
      .expect(200);
    expect(preview.headers['content-disposition']).toContain('inline');
    expect(Buffer.compare(preview.body as Buffer, PDF)).toBe(0);

    const download = await api('arc-sc')
      .get(`/archives/${data.id}/files/${file.id}/download`)
      .expect(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(Buffer.compare(download.body as Buffer, PDF)).toBe(0);

    const cleared = await api('arc-sc')
      .patch(`/archives/${data.id}`)
      .send({ fileIds: [] })
      .expect(200);
    expect(
      (cleared.body as ResponseEnvelope<ArchiveResponseDto>).data.fileIds,
    ).toEqual([]);

    const core = await api('arc-sc')
      .patch(`/archives/${data.id}/core`)
      .send({ core: 1 })
      .expect(200);
    expect(
      (core.body as ResponseEnvelope<ArchiveResponseDto>).data,
    ).toMatchObject({
      core: 1,
      retentionUntil: null,
    });

    const nonCore = await api('arc-sc')
      .patch(`/archives/${data.id}/core`)
      .send({ core: 0 })
      .expect(200);
    expect(
      (nonCore.body as ResponseEnvelope<ArchiveResponseDto>).data
        .retentionUntil,
    ).not.toBeNull();
  });

  it('判据 5：手工归档不允许调用方设置 core → 400 / 10001', async () => {
    const response = await api('arc-sc')
      .post('/archives')
      .send({
        targetType: 'Other',
        targetId: 'core-1',
        title: '想冒充核心',
        category: 'other',
        core: 1,
      })
      .expect(400);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PARAM_INVALID,
    );
  });

  it('判据 6：重复归档同一目标 → 409 / 37002', async () => {
    const response = await api('arc-sc')
      .post('/archives')
      .send({
        targetType: 'Achievement',
        targetId: '9001',
        title: '重复',
        category: 'achievement',
      })
      .expect(409);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.ARCHIVE_ALREADY_EXISTS,
    );
  });

  it('判据 7：targetType / category 白名单外 → 400 / 10001', async () => {
    for (const body of [
      {
        targetType: 'Unknown',
        targetId: '1',
        title: 'x',
        category: 'other',
      },
      {
        targetType: 'Other',
        targetId: '2',
        title: 'x',
        category: 'mentor-application',
      },
    ]) {
      const response = await api('arc-sc')
        .post('/archives')
        .send(body)
        .expect(400);
      expect((response.body as ResponseEnvelope<null>).code).toBe(
        ErrorCode.PARAM_INVALID,
      );
    }
  });

  it('判据 8：再手工归档一条 B 院材料（供部门范围判据用）', async () => {
    const response = await api('arc-sc')
      .post('/archives')
      .send({
        targetType: 'GuidanceRecord',
        targetId: '9101',
        title: 'B 院指导记录',
        category: 'guidance-record',
        mentorId: profiles.get('b1')?.toString(),
        deptId: dept('B').toString(),
      })
      .expect(201);
    manualBId = (response.body as ResponseEnvelope<ArchiveResponseDto>).data.id;
  });

  it('判据 9：双创学院检索全量，按 mentorId / category / targetType 过滤', async () => {
    const all = await api('arc-sc').get('/archives').expect(200);
    const allData = (all.body as ResponseEnvelope<ArchiveListResponseDto>).data;
    // 2 条自动（申请 A/B）+ 1 条考核自动 + 2 条手工 + 1 条附件用例
    expect(allData.total).toBe(6);

    const byMentor = await api('arc-sc')
      .get('/archives')
      .query({ mentorId: profiles.get('a1')?.toString() })
      .expect(200);
    expect(
      (byMentor.body as ResponseEnvelope<ArchiveListResponseDto>).data.total,
    ).toBe(3);

    const byCategory = await api('arc-sc')
      .get('/archives')
      .query({ category: 'assessment' })
      .expect(200);
    const categoryData = (
      byCategory.body as ResponseEnvelope<ArchiveListResponseDto>
    ).data;
    expect(categoryData.total).toBe(1);
    expect(categoryData.list[0]?.targetType).toBe('Assessment');

    const byType = await api('arc-sc')
      .get('/archives')
      .query({ targetType: 'MentorApplication' })
      .expect(200);
    expect(
      (byType.body as ResponseEnvelope<ArchiveListResponseDto>).data.total,
    ).toBe(2);
  });

  it('判据 10：检索按归档时间闭区间过滤', async () => {
    const today = utcDate(0);
    const yesterday = utcDate(-1);
    const hit = await api('arc-sc')
      .get('/archives')
      .query({ from: today, to: today })
      .expect(200);
    expect(
      (hit.body as ResponseEnvelope<ArchiveListResponseDto>).data.total,
    ).toBe(6);

    const miss = await api('arc-sc')
      .get('/archives')
      .query({ from: yesterday, to: yesterday })
      .expect(200);
    expect(
      (miss.body as ResponseEnvelope<ArchiveListResponseDto>).data.total,
    ).toBe(0);
  });

  it('判据 11：学院管理员只看到本院（按 deptId 快照）', async () => {
    const response = await api('arc-college-a').get('/archives').expect(200);
    const data = (response.body as ResponseEnvelope<ArchiveListResponseDto>)
      .data;
    expect(data.total).toBe(3);
    for (const row of data.list) {
      expect(row.deptId).toBe(dept('A').toString());
    }

    const cross = await api('arc-college-a')
      .get(`/archives/${manualBId}`)
      .expect(403);
    expect((cross.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  it('判据 12：导师只看自己的归档；看别人的 → 403', async () => {
    const response = await api('mentor-a1').get('/archives').expect(200);
    const data = (response.body as ResponseEnvelope<ArchiveListResponseDto>)
      .data;
    expect(data.total).toBe(3);
    for (const row of data.list) {
      expect(row.mentorId).toBe(profiles.get('a1')?.toString());
    }

    const cross = await api('mentor-a1')
      .get(`/archives/${manualBId}`)
      .expect(403);
    expect((cross.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  it('判据 13：没有 archive:list 的学生 → 403 / 10003', async () => {
    const response = await api('arc-student').get('/archives').expect(403);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  it('判据 14：详情不存在 → 404 / 37001', async () => {
    const response = await api('arc-sc').get('/archives/999999').expect(404);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.ARCHIVE_NOT_FOUND,
    );
  });

  it('判据 15：详情字段完整（BIGINT 一律字符串）', async () => {
    const response = await api('arc-sc')
      .get(`/archives/${manualAId}`)
      .expect(200);
    const data = (response.body as ResponseEnvelope<ArchiveResponseDto>).data;
    expect(data).toMatchObject({
      id: manualAId,
      targetType: 'Achievement',
      targetId: '9001',
      mentorId: profiles.get('a1')?.toString(),
      deptId: dept('A').toString(),
      core: 0,
    });
  });

  // ── Task 53：归档管理 + 过期清理 ─────────────────────────────────

  it('判据 16：PATCH 改标题 / 摘要 / 保留期（非核心）', async () => {
    const yesterday = dateOnlyInZone(new Date(), -1);
    const response = await api('arc-sc')
      .patch(`/archives/${manualAId}`)
      .send({
        title: '改过的标题',
        summary: '补充说明',
        retentionUntil: yesterday,
      })
      .expect(200);
    const data = (response.body as ResponseEnvelope<ArchiveResponseDto>).data;
    expect(data).toMatchObject({
      id: manualAId,
      title: '改过的标题',
      summary: '补充说明',
      retentionUntil: yesterday,
    });
  });

  it('判据 17：核心材料不允许设置保留期 → 400 / 10001', async () => {
    const core = await prisma.client.archiveItem.findFirst({
      where: {
        targetType: 'MentorApplication',
        targetId: appAId.toString(),
      },
    });
    if (core === null) {
      throw new Error('判据 1 没有落下自动归档');
    }
    const response = await api('arc-sc')
      .patch(`/archives/${core.id.toString()}`)
      .send({ retentionUntil: dateOnlyInZone(new Date(), 30) })
      .expect(400);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.PARAM_INVALID,
    );
  });

  it('判据 18：缺 archive:manage 的学院管理员改归档 → 403 / 10003', async () => {
    const response = await api('arc-college-a')
      .patch(`/archives/${manualAId}`)
      .send({ title: '越权' })
      .expect(403);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  it('判据 19：PATCH 不存在的归档 → 404 / 37001', async () => {
    const response = await api('arc-sc')
      .patch('/archives/999999')
      .send({ title: 'x' })
      .expect(404);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.ARCHIVE_NOT_FOUND,
    );
  });

  it('判据 20：DELETE 软删后同一目标可再归档', async () => {
    const response = await api('arc-sc')
      .delete(`/archives/${manualBId}`)
      .expect(200);
    expect((response.body as ResponseEnvelope<{ id: string }>).data).toEqual({
      id: manualBId,
    });

    await api('arc-sc').get(`/archives/${manualBId}`).expect(404);

    const again = await api('arc-sc')
      .post('/archives')
      .send({
        targetType: 'GuidanceRecord',
        targetId: '9101',
        title: 'B 院指导记录（重新归档）',
        category: 'guidance-record',
        mentorId: profiles.get('b1')?.toString(),
        deptId: dept('B').toString(),
      })
      .expect(201);
    manualBId = (again.body as ResponseEnvelope<ArchiveResponseDto>).data.id;
  });

  it('判据 21：过期清理只清非核心过期项，核心永不清，SysFile 不动', async () => {
    const today = dateOnlyInZone(new Date(), 0);
    const yesterday = dateOnlyInZone(new Date(), -1);
    const tenYearsAgo = dateOnlyInZone(new Date(), -3650);

    // 核心条目：直改库把保留期设成 10 年前（绕过 Service 的守卫）
    const core = await prisma.client.archiveItem.findFirst({
      where: {
        targetType: 'MentorApplication',
        targetId: appAId.toString(),
      },
    });
    if (core === null) {
      throw new Error('判据 1 没有落下自动归档');
    }
    await prisma.client.archiveItem.update({
      where: { id: core.id },
      data: { retentionUntil: new Date(`${tenYearsAgo}T00:00:00.000Z`) },
    });

    const todayRowId = await createManualArchive(
      'purge-today',
      '今天到期',
      today,
    );
    const expiredRowId = await createManualArchive(
      'purge-yesterday',
      '昨天到期',
      yesterday,
    );

    const file = await prisma.client.sysFile.create({
      data: {
        originName: '归档佐证.pdf',
        storageName: 'archive-proof.pdf',
        ext: 'pdf',
        mimeType: 'application/pdf',
        size: 1,
        sha256: '0'.repeat(64),
        createdBy: 0n,
        updatedBy: 0n,
      },
    });

    // manualA（判据 16 改成昨天到期）+ purge-yesterday
    const response = await api('arc-sc').post('/archives/purge').expect(200);
    expect(
      (response.body as ResponseEnvelope<{ purged: number }>).data,
    ).toEqual({ purged: 2 });

    const coreAfter = await prisma.client.archiveItem.findFirst({
      where: { id: core.id },
    });
    expect(coreAfter?.deletedAt).toBeNull();
    const todayAfter = await prisma.client.archiveItem.findFirst({
      where: { id: BigInt(todayRowId) },
    });
    expect(todayAfter?.deletedAt).toBeNull();
    const expiredAfter = await prisma.client.archiveItem.findFirst({
      where: { id: BigInt(expiredRowId) },
    });
    expect(expiredAfter?.deletedAt).not.toBeNull();

    // R65：清理不碰文件
    const fileAfter = await prisma.client.sysFile.findFirst({
      where: { id: file.id },
    });
    expect(fileAfter).not.toBeNull();

    // 幂等：第二次没有候选
    const second = await api('arc-sc').post('/archives/purge').expect(200);
    expect((second.body as ResponseEnvelope<{ purged: number }>).data).toEqual({
      purged: 0,
    });

    // 软删后可再归档同一目标
    await api('arc-sc')
      .post('/archives')
      .send({
        targetType: 'Other',
        targetId: 'purge-yesterday',
        title: '清理后再归档',
        category: 'other',
      })
      .expect(201);
  });

  it('判据 22：缺 archive:manage 的学院管理员调 purge → 403 / 10003', async () => {
    const response = await api('arc-college-a')
      .post('/archives/purge')
      .expect(403);
    expect((response.body as ResponseEnvelope<null>).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });
});

async function clearArchiveTables(prisma: PrismaService): Promise<void> {
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
