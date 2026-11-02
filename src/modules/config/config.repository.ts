import { Injectable } from '@nestjs/common';
import type { SysConfig } from '@prisma/client';
import { currentActorId } from '../../common/context/request-context';
import { PrismaService } from '../../infra/prisma/prisma.service';

@Injectable()
export class ConfigRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(params: {
    code?: string;
    name?: string;
    status?: number;
    page: number;
    pageSize: number;
  }): Promise<{ rows: SysConfig[]; total: number }> {
    const where = {
      ...(params.code === undefined ? {} : { code: { contains: params.code } }),
      ...(params.name === undefined ? {} : { name: { contains: params.name } }),
      ...(params.status === undefined ? {} : { status: params.status }),
    };

    const [total, rows] = await Promise.all([
      this.prisma.client.sysConfig.count({ where }),
      this.prisma.client.sysConfig.findMany({
        where,
        orderBy: [{ code: 'asc' }],
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
    ]);

    return { rows, total };
  }

  async findById(id: bigint): Promise<SysConfig | null> {
    return this.prisma.client.sysConfig.findFirst({ where: { id } });
  }

  /** 业务代码按编码取值；只返回启用的那条 */
  async findByCode(code: string): Promise<SysConfig | null> {
    return this.prisma.client.sysConfig.findFirst({
      where: { code, status: 1 },
    });
  }

  /**
   * 按编码取**任意状态**的那条（写入路径用）。
   *
   * `findByCode` 只认 `status = 1`；停用的同 code 行仍占着
   * `uk_sys_config_code_active`，直接 create 会撞唯一键。
   */
  async findAnyByCode(code: string): Promise<SysConfig | null> {
    return this.prisma.client.sysConfig.findFirst({ where: { code } });
  }

  /** 同编码的配置是否已存在（uk_sys_config_code_active） */
  async existsByCode(code: string, excludeId?: bigint): Promise<boolean> {
    const found = await this.prisma.client.sysConfig.findFirst({
      where: {
        code,
        ...(excludeId === undefined ? {} : { id: { not: excludeId } }),
      },
      select: { id: true },
    });

    return found !== null;
  }

  async create(data: {
    code: string;
    name: string;
    value: string;
    valueType: string;
    status: number;
    remark?: string;
  }): Promise<SysConfig> {
    // createdBy / updatedBy 是类型层面的必需字段，运行时被扩展剥掉重写
    // （同 dept.repository.ts:30-34）
    return this.prisma.client.sysConfig.create({
      data: { ...data, createdBy: 0n, updatedBy: 0n },
    });
  }

  async update(
    id: bigint,
    data: {
      code?: string;
      name?: string;
      value?: string;
      valueType?: string;
      status?: number;
      remark?: string | null;
    },
  ): Promise<SysConfig> {
    return this.prisma.client.sysConfig.update({ where: { id }, data });
  }

  async softDelete(id: bigint): Promise<void> {
    // 软删除是显式 update（R24，同 dept.repository.ts 的 softDelete）
    await this.prisma.client.sysConfig.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: currentActorId() },
    });
  }
}
