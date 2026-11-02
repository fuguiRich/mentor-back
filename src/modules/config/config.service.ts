import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCode } from '../../common/constants/error-code';
import { BusinessException } from '../../common/errors/business.exception';
import {
  isValueMatchingType,
  parseNumberValue,
  type ConfigValueType,
} from './config.constants';
import { ConfigRepository } from './config.repository';
import { toConfigResponse } from './config.mapper';
import type {
  ConfigPageResponseDto,
  CreateConfigDto,
  QueryConfigDto,
  UpdateConfigDto,
} from './dto/config.dto';
import type { ConfigResponseDto } from './dto/config-response.dto';

@Injectable()
export class ConfigService {
  constructor(private readonly repository: ConfigRepository) {}

  async findPage(query: QueryConfigDto): Promise<ConfigPageResponseDto> {
    const { rows, total } = await this.repository.findMany({
      ...(query.code === undefined ? {} : { code: query.code }),
      ...(query.name === undefined ? {} : { name: query.name }),
      ...(query.status === undefined ? {} : { status: query.status }),
      page: query.page,
      pageSize: query.pageSize,
    });

    return {
      list: rows.map(toConfigResponse),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async findOne(id: bigint): Promise<ConfigResponseDto> {
    return toConfigResponse(await this.assertExists(id));
  }

  async create(dto: CreateConfigDto): Promise<ConfigResponseDto> {
    await this.assertCodeAvailable(dto.code);
    this.assertValueMatchesType(dto.value, dto.valueType);

    try {
      const created = await this.repository.create({
        code: dto.code,
        name: dto.name,
        value: dto.value,
        valueType: dto.valueType,
        status: dto.status ?? 1,
        ...(dto.remark === undefined ? {} : { remark: dto.remark }),
      });
      return toConfigResponse(created);
    } catch (error) {
      this.rethrowIfCodeTaken(error);
      throw error;
    }
  }

  async update(id: bigint, dto: UpdateConfigDto): Promise<ConfigResponseDto> {
    const current = await this.assertExists(id);
    this.rejectNullFields(dto, ['code', 'valueType', 'status']);

    const nextCode = dto.code === undefined ? current.code : dto.code;
    if (nextCode !== current.code) {
      await this.assertCodeAvailable(nextCode, id);
    }

    // 类型与值都可能是「保持原值」——对齐校验必须落在**生效后**的那一组上。
    // 少一半就会出两种错：只改 value 不传 valueType 时拿旧类型校验新值（碰巧能过）；
    // 只改 valueType 不传 value 时拿新类型校验 undefined（直接 TypeError），
    // 或者拿新类型校验旧值却用的是请求里的空值——假阴。
    const nextValueType =
      dto.valueType === undefined
        ? (current.valueType as ConfigValueType)
        : (dto.valueType as ConfigValueType);
    const nextValue = dto.value === undefined ? current.value : dto.value;
    this.assertValueMatchesType(nextValue, nextValueType);

    try {
      const updated = await this.repository.update(id, {
        code: nextCode,
        name: dto.name,
        value: nextValue,
        valueType: nextValueType,
        ...(dto.status === undefined ? {} : { status: dto.status }),
        ...(dto.remark === undefined ? {} : { remark: dto.remark }),
      });
      return toConfigResponse(updated);
    } catch (error) {
      this.rethrowIfCodeTaken(error);
      throw error;
    }
  }

  async remove(id: bigint): Promise<void> {
    await this.assertExists(id);
    await this.repository.softDelete(id);
  }

  /**
   * 业务代码取配置值。取不到（不存在 / 已停用）返回 defaultValue。
   *
   * **不抛**：配置是「可缺省的运行期参数」，缺一条不该把业务请求打断成 500。
   * 调用方必须显式给 defaultValue，于是「缺了用什么」在调用点就是一行可见的事实。
   */
  async getString(code: string, defaultValue: string): Promise<string> {
    const row = await this.repository.findByCode(code);
    return row === null ? defaultValue : row.value;
  }

  /**
   * 按编码取数值；解析不出来或缺失都回 defaultValue。
   * 解析规则与写入校验同源（`parseNumberValue`），避免「写得进、读不出」。
   */
  async getNumber(code: string, defaultValue: number): Promise<number> {
    const row = await this.repository.findByCode(code);
    if (row === null || row.valueType !== 'number') {
      return defaultValue;
    }
    return parseNumberValue(row.value) ?? defaultValue;
  }

  /** 按编码取布尔；缺失或不是 boolean 类型都回 defaultValue */
  async getBoolean(code: string, defaultValue: boolean): Promise<boolean> {
    const row = await this.repository.findByCode(code);
    if (row === null || row.valueType !== 'boolean') {
      return defaultValue;
    }
    return row.value === 'true';
  }

  /**
   * 按编码写数值（业务规则的写入口，如 §6.6 的考核权重）。
   *
   * 与 `create` / `update` 的差别：调用方只关心「这个 code 现在等于多少」，
   * 不需要先知道行 ID。停用的同 code 行会被**重新启用**，而不是撞唯一键。
   */
  async setNumber(code: string, name: string, value: number): Promise<void> {
    const text = String(value);
    const existing = await this.repository.findAnyByCode(code);
    if (existing === null) {
      await this.repository.create({
        code,
        name,
        value: text,
        valueType: 'number',
        status: 1,
      });
      return;
    }
    await this.repository.update(existing.id, {
      name,
      value: text,
      valueType: 'number',
      status: 1,
    });
  }

  // ── 断言与错误 ────────────────────────────────────────────────

  private async assertExists(id: bigint) {
    const entity = await this.repository.findById(id);
    if (entity === null) {
      throw new BusinessException(
        ErrorCode.CONFIG_NOT_FOUND,
        '系统配置不存在',
        HttpStatus.NOT_FOUND,
      );
    }
    return entity;
  }

  private async assertCodeAvailable(
    code: string,
    excludeId?: bigint,
  ): Promise<void> {
    const taken = await this.repository.existsByCode(code, excludeId);
    if (taken) {
      throw new BusinessException(
        ErrorCode.CONFIG_CODE_TAKEN,
        '系统配置编码已存在',
        HttpStatus.CONFLICT,
      );
    }
  }

  /** value 与 valueType 不符时抛 400。两个错误码分开：类型不合法 vs 值与类型不符 */
  private assertValueMatchesType(value: string, valueType: string): void {
    if (
      valueType !== 'string' &&
      valueType !== 'number' &&
      valueType !== 'boolean' &&
      valueType !== 'json'
    ) {
      throw new BusinessException(
        ErrorCode.CONFIG_VALUE_TYPE_INVALID,
        '配置值类型只能是 string / number / boolean / json',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!isValueMatchingType(value, valueType)) {
      throw new BusinessException(
        ErrorCode.CONFIG_VALUE_MISMATCH,
        '配置值与声明的类型不符',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * PartialType 的 @IsOptional() 挡不住 null（同 role.service.ts 的长注释）：
   * 这些列在库里是 NOT NULL，null 一路进 Prisma 会把「字段值非法」变成 500。
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
  private rethrowIfCodeTaken(error: unknown): never | void {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'P2002'
    ) {
      throw new BusinessException(
        ErrorCode.CONFIG_CODE_TAKEN,
        '系统配置编码已存在',
        HttpStatus.CONFLICT,
      );
    }
  }
}
