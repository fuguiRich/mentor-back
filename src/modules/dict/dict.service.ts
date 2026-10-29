import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCode } from '../../common/constants/error-code';
import { BusinessException } from '../../common/errors/business.exception';
import { DictRepository } from './dict.repository';
import { toDictItemResponse, toDictTypeResponse } from './dict.mapper';
import type { DictItemResponseDto } from './dto/dict-item-response.dto';
import type { DictTypeResponseDto } from './dto/dict-type-response.dto';
import type {
  DictItemPageResponseDto,
  DictTypePageResponseDto,
} from './dto/dict-page-response.dto';
import type { CreateDictItemDto } from './dto/create-dict-item.dto';
import type { CreateDictTypeDto } from './dto/create-dict-type.dto';
import type { QueryDictItemDto } from './dto/query-dict-item.dto';
import type { QueryDictTypeDto } from './dto/query-dict-type.dto';
import type { UpdateDictItemDto } from './dto/update-dict-item.dto';
import type { UpdateDictTypeDto } from './dto/update-dict-type.dto';

@Injectable()
export class DictService {
  constructor(private readonly repository: DictRepository) {}

  // ── 字典类型 ──────────────────────────────────────────────────

  async findTypes(query: QueryDictTypeDto): Promise<DictTypePageResponseDto> {
    const { rows, total } = await this.repository.findTypes({
      ...(query.code === undefined ? {} : { code: query.code }),
      ...(query.name === undefined ? {} : { name: query.name }),
      ...(query.status === undefined ? {} : { status: query.status }),
      page: query.page,
      pageSize: query.pageSize,
    });

    return {
      list: rows.map(toDictTypeResponse),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async findType(id: bigint): Promise<DictTypeResponseDto> {
    return toDictTypeResponse(await this.assertTypeExists(id));
  }

  async createType(dto: CreateDictTypeDto): Promise<DictTypeResponseDto> {
    await this.assertTypeCodeAvailable(dto.code);

    try {
      const created = await this.repository.createType({
        code: dto.code,
        name: dto.name,
        status: dto.status ?? 1,
        ...(dto.remark === undefined ? {} : { remark: dto.remark }),
      });
      return toDictTypeResponse(created);
    } catch (error) {
      this.rethrowIfTypeCodeTaken(error);
      throw error;
    }
  }

  async updateType(
    id: bigint,
    dto: UpdateDictTypeDto,
  ): Promise<DictTypeResponseDto> {
    const current = await this.assertTypeExists(id);
    this.rejectNullFields(dto, ['code', 'status']);

    const nextCode = dto.code === undefined ? current.code : dto.code;
    if (nextCode !== current.code) {
      await this.assertTypeCodeAvailable(nextCode, id);
    }

    try {
      const updated = await this.repository.updateType(id, {
        code: nextCode,
        name: dto.name,
        ...(dto.status === undefined ? {} : { status: dto.status }),
        ...(dto.remark === undefined ? {} : { remark: dto.remark }),
      });
      return toDictTypeResponse(updated);
    } catch (error) {
      this.rethrowIfTypeCodeTaken(error);
      throw error;
    }
  }

  async deleteType(id: bigint): Promise<void> {
    await this.assertTypeExists(id);

    // 先判「底下还有没有项」再软删。反过来的话，删除会先成功、再发现有项，
    // 而那时类型已经不可见了——「删不掉」和「已经删了」在一次请求里同时成立。
    const itemCount = await this.repository.countItemsByTypeId(id);
    if (itemCount > 0) {
      throw new BusinessException(
        ErrorCode.DICT_TYPE_HAS_ITEMS,
        '该字典类型下还有字典项，请先移走或删除',
        HttpStatus.CONFLICT,
      );
    }

    await this.repository.softDeleteType(id);
  }

  // ── 字典项 ──────────────────────────────────────────────────

  async findItems(query: QueryDictItemDto): Promise<DictItemPageResponseDto> {
    const { rows, total } = await this.repository.findItems({
      ...(query.dictTypeId === undefined
        ? {}
        : { dictTypeId: BigInt(query.dictTypeId) }),
      ...(query.dictTypeCode === undefined
        ? {}
        : { dictTypeCode: query.dictTypeCode }),
      ...(query.label === undefined ? {} : { label: query.label }),
      ...(query.status === undefined ? {} : { status: query.status }),
      page: query.page,
      pageSize: query.pageSize,
    });

    return {
      list: rows.map(toDictItemResponse),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async findItem(id: bigint): Promise<DictItemResponseDto> {
    return toDictItemResponse(await this.assertItemExists(id));
  }

  async createItem(dto: CreateDictItemDto): Promise<DictItemResponseDto> {
    const dictTypeId = BigInt(dto.dictTypeId);
    await this.assertTypeExists(dictTypeId);
    await this.assertItemValueAvailable(dictTypeId, dto.value);

    try {
      const created = await this.repository.createItem({
        dictTypeId,
        label: dto.label,
        value: dto.value,
        sortOrder: dto.sortOrder ?? 0,
        status: dto.status ?? 1,
        ...(dto.remark === undefined ? {} : { remark: dto.remark }),
      });
      return toDictItemResponse(created);
    } catch (error) {
      this.rethrowIfItemValueTaken(error);
      throw error;
    }
  }

  async updateItem(
    id: bigint,
    dto: UpdateDictItemDto,
  ): Promise<DictItemResponseDto> {
    const current = await this.assertItemExists(id);
    this.rejectNullFields(dto, ['value', 'sortOrder', 'status']);

    const nextValue = dto.value === undefined ? current.value : dto.value;
    if (nextValue !== current.value) {
      await this.assertItemValueAvailable(current.dictTypeId, nextValue, id);
    }

    try {
      const updated = await this.repository.updateItem(id, {
        label: dto.label,
        value: nextValue,
        ...(dto.sortOrder === undefined ? {} : { sortOrder: dto.sortOrder }),
        ...(dto.status === undefined ? {} : { status: dto.status }),
        ...(dto.remark === undefined ? {} : { remark: dto.remark }),
      });
      return toDictItemResponse(updated);
    } catch (error) {
      this.rethrowIfItemValueTaken(error);
      throw error;
    }
  }

  async deleteItem(id: bigint): Promise<void> {
    await this.assertItemExists(id);
    await this.repository.softDeleteItem(id);
  }

  // ── 断言与错误 ────────────────────────────────────────────────

  /** 取字典类型；不存在抛 404。返回实体供调用方比对旧值 */
  private async assertTypeExists(id: bigint) {
    const entity = await this.repository.findTypeById(id);
    if (entity === null) {
      throw new BusinessException(
        ErrorCode.DICT_TYPE_NOT_FOUND,
        '字典类型不存在',
        HttpStatus.NOT_FOUND,
      );
    }
    return entity;
  }

  private async assertItemExists(id: bigint) {
    const entity = await this.repository.findItemById(id);
    if (entity === null) {
      throw new BusinessException(
        ErrorCode.DICT_ITEM_NOT_FOUND,
        '字典项不存在',
        HttpStatus.NOT_FOUND,
      );
    }
    return entity;
  }

  private async assertTypeCodeAvailable(
    code: string,
    excludeId?: bigint,
  ): Promise<void> {
    const taken = await this.repository.existsTypeByCode(code, excludeId);
    if (taken) {
      throw new BusinessException(
        ErrorCode.DICT_TYPE_CODE_TAKEN,
        '字典类型编码已存在',
        HttpStatus.CONFLICT,
      );
    }
  }

  private async assertItemValueAvailable(
    dictTypeId: bigint,
    value: string,
    excludeId?: bigint,
  ): Promise<void> {
    const taken = await this.repository.existsItemByTypeAndValue(
      dictTypeId,
      value,
      excludeId,
    );
    if (taken) {
      throw new BusinessException(
        ErrorCode.DICT_ITEM_VALUE_TAKEN,
        '同字典类型下已存在相同的字典值',
        HttpStatus.CONFLICT,
      );
    }
  }

  /**
   * PartialType 的 @IsOptional() 挡不住 null（同 role.service.ts 的长注释）：
   * 这些列在库里是 NOT NULL，null 一路进 Prisma 会把「字段值非法」变成 500。
   * 在 Service 明确挡，干净地回 400。
   */
  private rejectNullFields(dto: object, fields: readonly string[]): void {
    const nullFields = fields.filter(
      (field) => (dto as Record<string, unknown>)[field] === null,
    );
    if (nullFields.length > 0) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        `${nullFields.join('、')} 不能为 null`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /** DB 层的生成列唯一索引兜底（应用层判重漏了时不至于脏写） */
  private rethrowIfTypeCodeTaken(error: unknown): never | void {
    if (this.isUniqueViolation(error)) {
      throw new BusinessException(
        ErrorCode.DICT_TYPE_CODE_TAKEN,
        '字典类型编码已存在',
        HttpStatus.CONFLICT,
      );
    }
  }

  private rethrowIfItemValueTaken(error: unknown): never | void {
    if (this.isUniqueViolation(error)) {
      throw new BusinessException(
        ErrorCode.DICT_ITEM_VALUE_TAKEN,
        '同字典类型下已存在相同的字典值',
        HttpStatus.CONFLICT,
      );
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'P2002'
    );
  }
}
