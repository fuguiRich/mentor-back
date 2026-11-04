import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { hashSync } from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { BCRYPT_ROUNDS } from '../src/common/constants/auth.constants';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { SsoUserProvisioner } from '../src/modules/sync/sso/sso-user-provisioner';
import { clearBusinessTables } from './e2e-helpers';

async function clearSyncTables(prisma: PrismaService): Promise<void> {
  const tables = [
    'mentor_profile',
    'sync_person',
    'sync_org_unit',
    'sync_run',
  ];
  for (const table of tables) {
    await prisma.client.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
}

describe('SSO 首次登录自动建号 (e2e)', () => {
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

    await clearBusinessTables(prisma);
    await clearSyncTables(prisma);

    // 根部门 + 超管（根部门是 provisioner 的挂靠点）
    const root = await prisma.client.sysDept.create({
      data: {
        parentId: null,
        name: '总公司',
        sortOrder: 0,
        status: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
    await prisma.client.sysUser.create({
      data: {
        username: 'admin',
        password: hashSync('Passw0rd!', BCRYPT_ROUNDS),
        realName: '超级管理员',
        employeeNo: 'admin',
        deptId: root.id,
        status: 1,
        isSuperAdmin: true,
        authSource: 'local',
        createdBy: 0n,
        updatedBy: 0n,
      },
    });
  });

  afterAll(async () => {
    try {
      if (prisma !== undefined) {
        await clearBusinessTables(prisma);
        await clearSyncTables(prisma);
      }
    } finally {
      if (app !== undefined) {
        await app.close();
      }
    }
  });

  it('自动建号：teacher → SysUser(authSource=sso) + SyncPerson(teacher) + mentor 角色', async () => {
    const root = await prisma.client.sysDept.findFirst({
      where: { parentId: null },
    });
    await prisma.client.sysRole.create({
      data: {
        code: 'mentor',
        name: '导师',
        dataScope: 'self',
        status: 1,
        createdBy: 0n,
        updatedBy: 0n,
      },
    });

    const provisioner = app.get(SsoUserProvisioner);
    const { userId } = await provisioner.ensureUser({
      login: 'T900',
      realName: '教师甲',
      userType: 'teacher',
      deptId: '10',
      deptName: '计算机学院',
      passwordHash: hashSync('Passw0rd!', BCRYPT_ROUNDS),
    });

    const user = await prisma.client.sysUser.findFirst({ where: { id: userId } });
    expect(user).toMatchObject({
      username: 'T900',
      employeeNo: 'T900',
      realName: '教师甲',
      authSource: 'sso',
      status: 1,
    });

    const person = await prisma.client.syncPerson.findFirst({
      where: { login: 'T900' },
    });
    expect(person?.personType).toBe('teacher');

    const unit = await prisma.client.syncOrgUnit.findFirst({
      where: { code: 'sso:10' },
    });
    expect(unit).not.toBeNull();

    const dept = await prisma.client.sysDept.findFirst({
      where: { name: '计算机学院' },
    });
    expect(dept?.parentId).toBe(root?.id);

    const mentorRole = await prisma.client.sysRole.findFirst({
      where: { code: 'mentor' },
    });
    const bound = await prisma.client.sysUserRole.findFirst({
      where: { userId, roleId: mentorRole?.id },
    });
    expect(bound).not.toBeNull();
  });

  it('重复调用幂等：不新建第二条 SysUser / SyncPerson', async () => {
    const provisioner = app.get(SsoUserProvisioner);
    const first = await provisioner.ensureUser({
      login: 'T901',
      realName: '教师乙',
      userType: 'teacher',
      deptId: null,
      deptName: null,
      passwordHash: hashSync('x', BCRYPT_ROUNDS),
    });
    const second = await provisioner.ensureUser({
      login: 'T901',
      realName: '教师乙',
      userType: 'teacher',
      deptId: null,
      deptName: null,
      passwordHash: hashSync('x', BCRYPT_ROUNDS),
    });

    expect(second.userId).toBe(first.userId);
    expect(
      await prisma.client.sysUser.count({ where: { username: 'T901' } }),
    ).toBe(1);
    expect(
      await prisma.client.syncPerson.count({ where: { login: 'T901' } }),
    ).toBe(1);
  });
});
