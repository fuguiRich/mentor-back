import { Injectable } from '@nestjs/common';
import type { SysFile } from '@prisma/client';
import { currentActorId } from '../../common/context/request-context';
import { PrismaService } from '../../infra/prisma/prisma.service';

@Injectable()
export class FileRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(params: {
    originName?: string;
    createdBy?: bigint;
    page: number;
    pageSize: number;
  }): Promise<{ rows: SysFile[]; total: number }> {
    const where = {
      ...(params.originName === undefined
        ? {}
        : { originName: { contains: params.originName } }),
      ...(params.createdBy === undefined
        ? {}
        : { createdBy: params.createdBy }),
    };

    const [total, rows] = await Promise.all([
      this.prisma.client.sysFile.count({ where }),
      this.prisma.client.sysFile.findMany({
        where,
        orderBy: [{ id: 'desc' }],
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
    ]);

    return { rows, total };
  }

  async findById(id: bigint): Promise<SysFile | null> {
    return this.prisma.client.sysFile.findFirst({ where: { id } });
  }

  async create(data: {
    originName: string;
    storageName: string;
    ext: string;
    mimeType: string;
    size: number;
    sha256: string;
    ownerType: string | null;
    ownerId: bigint | null;
  }): Promise<SysFile> {
    // createdBy / updatedBy 是类型层面的必需字段，运行时被扩展按
    // currentActorId() 重写（同 dept.repository.ts:30-34）——上传人即创建人
    return this.prisma.client.sysFile.create({
      data: { ...data, createdBy: 0n, updatedBy: 0n },
    });
  }

  async softDelete(id: bigint): Promise<void> {
    // 软删除是显式 update（R24，同 dept.repository.ts 的 softDelete）。
    // 磁盘文件不在这里删——业务表里可能还有引用，删了就是引用悬空；
    // 磁盘清理属于归档策略，不在请求路径上做。
    await this.prisma.client.sysFile.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: currentActorId() },
    });
  }
}
