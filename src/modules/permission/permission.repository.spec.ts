import type { PrismaService } from '../../infra/prisma/prisma.service';
import { PermissionRepository } from './permission.repository';

describe('PermissionRepository.findCodesByUserId 的查询形状', () => {
  it('where 必须同时含 status: 1 与嵌套的 role.deletedAt: null', async () => {
    let captured: Record<string, unknown> | undefined;
    const prisma = {
      client: {
        sysPermission: {
          findMany: (args: Record<string, unknown>): Promise<unknown[]> => {
            captured = args;
            return Promise.resolve([]);
          },
        },
      },
    } as unknown as PrismaService;

    await new PermissionRepository(prisma).findCodesByUserId(1n);

    const where = captured?.where as Record<string, unknown>;
    expect(where.status).toBe(1);
    expect(where.code).toEqual({ not: null });

    const rolePermissions = where.rolePermissions as {
      some: { role: Record<string, unknown> };
    };
    // 漏了嵌套 deletedAt: null，软删的角色照样发权限，而且是静默的——
    // 扩展的软删除过滤只补**顶层** where（audit-args.util.ts 的 withNotDeleted）
    expect(rolePermissions.some.role.deletedAt).toBeNull();
    expect(rolePermissions.some.role.status).toBe(1);
  });

  it('code 为 null 的行不会进结果（flatMap 把 null 折掉）', async () => {
    const prisma = {
      client: {
        sysPermission: {
          findMany: (): Promise<unknown[]> =>
            Promise.resolve([{ code: 'a:b' }, { code: null }, { code: 'c:d' }]),
        },
      },
    } as unknown as PrismaService;

    const codes = await new PermissionRepository(prisma).findCodesByUserId(1n);

    expect(codes).toEqual(['a:b', 'c:d']);
  });
});
