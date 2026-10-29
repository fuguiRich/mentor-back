import { Injectable } from '@nestjs/common';
import type { SysDictItem, SysDictType } from '@prisma/client';
import { currentActorId } from '../../common/context/request-context';
import { PrismaService } from '../../infra/prisma/prisma.service';

@Injectable()
export class DictRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── 字典类型 ──────────────────────────────────────────────────

  async findTypes(params: {
    code?: string;
    name?: string;
    status?: number;
    page: number;
    pageSize: number;
  }): Promise<{ rows: SysDictType[]; total: number }> {
    const where = {
      ...(params.code === undefined ? {} : { code: { contains: params.code } }),
      ...(params.name === undefined ? {} : { name: { contains: params.name } }),
      ...(params.status === undefined ? {} : { status: params.status }),
    };

    const [total, rows] = await Promise.all([
      this.prisma.client.sysDictType.count({ where }),
      this.prisma.client.sysDictType.findMany({
        where,
        orderBy: [{ id: 'asc' }],
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
    ]);

    return { rows, total };
  }

  async findTypeById(id: bigint): Promise<SysDictType | null> {
    return this.prisma.client.sysDictType.findFirst({ where: { id } });
  }

  async findTypeByCode(code: string): Promise<SysDictType | null> {
    return this.prisma.client.sysDictType.findFirst({ where: { code } });
  }

  /** 同编码的类型是否已存在（uk_sys_dict_type_code_active） */
  async existsTypeByCode(code: string, excludeId?: bigint): Promise<boolean> {
    const found = await this.prisma.client.sysDictType.findFirst({
      where: {
        code,
        ...(excludeId === undefined ? {} : { id: { not: excludeId } }),
      },
      select: { id: true },
    });

    return found !== null;
  }

  async countItemsByTypeId(dictTypeId: bigint): Promise<number> {
    return this.prisma.client.sysDictItem.count({ where: { dictTypeId } });
  }

  async createType(data: {
    code: string;
    name: string;
    status: number;
    remark?: string;
  }): Promise<SysDictType> {
    // createdBy / updatedBy 是类型层面的必需字段，运行时被扩展剥掉重写
    // （同 dept.repository.ts:30-34）
    return this.prisma.client.sysDictType.create({
      data: { ...data, createdBy: 0n, updatedBy: 0n },
    });
  }

  async updateType(
    id: bigint,
    data: {
      code?: string;
      name?: string;
      status?: number;
      remark?: string | null;
    },
  ): Promise<SysDictType> {
    return this.prisma.client.sysDictType.update({ where: { id }, data });
  }

  async softDeleteType(id: bigint): Promise<void> {
    // 软删除是显式 update（R24，同 dept.repository.ts 的 softDelete）
    await this.prisma.client.sysDictType.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: currentActorId() },
    });
  }

  // ── 字典项 ──────────────────────────────────────────────────

  async findItems(params: {
    dictTypeId?: bigint;
    dictTypeCode?: string;
    label?: string;
    status?: number;
    page: number;
    pageSize: number;
  }): Promise<{ rows: SysDictItem[]; total: number }> {
    const where = {
      ...(params.dictTypeId === undefined
        ? {}
        : { dictTypeId: params.dictTypeId }),
      ...(params.dictTypeCode === undefined
        ? {}
        : { dictType: { code: params.dictTypeCode } }),
      ...(params.label === undefined
        ? {}
        : { label: { contains: params.label } }),
      ...(params.status === undefined ? {} : { status: params.status }),
    };

    const [total, rows] = await Promise.all([
      this.prisma.client.sysDictItem.count({ where }),
      this.prisma.client.sysDictItem.findMany({
        where,
        orderBy: [{ dictTypeId: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
    ]);

    return { rows, total };
  }

  async findItemById(id: bigint): Promise<SysDictItem | null> {
    return this.prisma.client.sysDictItem.findFirst({ where: { id } });
  }

  /** 同类型内 value 唯一（uk_sys_dict_item_type_value_active） */
  async existsItemByTypeAndValue(
    dictTypeId: bigint,
    value: string,
    excludeId?: bigint,
  ): Promise<boolean> {
    const found = await this.prisma.client.sysDictItem.findFirst({
      where: {
        dictTypeId,
        value,
        ...(excludeId === undefined ? {} : { id: { not: excludeId } }),
      },
      select: { id: true },
    });

    return found !== null;
  }

  async createItem(data: {
    dictTypeId: bigint;
    label: string;
    value: string;
    sortOrder: number;
    status: number;
    remark?: string;
  }): Promise<SysDictItem> {
    return this.prisma.client.sysDictItem.create({
      data: { ...data, createdBy: 0n, updatedBy: 0n },
    });
  }

  async updateItem(
    id: bigint,
    data: {
      label?: string;
      value?: string;
      sortOrder?: number;
      status?: number;
      remark?: string | null;
    },
  ): Promise<SysDictItem> {
    return this.prisma.client.sysDictItem.update({ where: { id }, data });
  }

  async softDeleteItem(id: bigint): Promise<void> {
    await this.prisma.client.sysDictItem.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: currentActorId() },
    });
  }
}
