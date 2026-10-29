import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorCode } from '../../common/constants/error-code';
import { errExample } from '../../common/dto/err-example';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { DictService } from './dict.service';
import { DictItemParamDto, DictTypeParamDto } from './dto/dict-param.dto';
import {
  DictItemPageResponseDto,
  DictTypePageResponseDto,
} from './dto/dict-page-response.dto';
import { QueryDictItemDto } from './dto/query-dict-item.dto';
import { QueryDictTypeDto } from './dto/query-dict-type.dto';
import { CreateDictItemDto } from './dto/create-dict-item.dto';
import { CreateDictTypeDto } from './dto/create-dict-type.dto';
import { UpdateDictItemDto } from './dto/update-dict-item.dto';
import { UpdateDictTypeDto } from './dto/update-dict-type.dto';
import { DictItemResponseDto } from './dto/dict-item-response.dto';
import { DictTypeResponseDto } from './dto/dict-type-response.dto';

@ApiTags('数据字典')
@Controller()
export class DictController {
  constructor(private readonly dictService: DictService) {}

  // ── 字典类型 ──────────────────────────────────────────────────

  @Get('dict-types')
  @RequirePermission('dict:list')
  @ApiOperation({
    summary: '查询字典类型列表（分页）',
    description:
      '字典管理页的主视图。可按编码 / 名称 / 状态筛选，编码与名称是模糊匹配。' +
      '返回统一的分页结构 { list, total, page, pageSize }（规范 RES-06）。不返回已软删除的类型。',
  })
  @ApiOkResponse({
    type: DictTypePageResponseDto,
    description: '查询成功；没有命中时 list 为 []、total 为 0',
  })
  async findTypes(
    @Query() query: QueryDictTypeDto,
  ): Promise<DictTypePageResponseDto> {
    return this.dictService.findTypes(query);
  }

  @Get('dict-types/:id')
  @RequirePermission('dict:list')
  @ApiOperation({
    summary: '查询字典类型详情',
    description: '编辑表单回填用。',
  })
  @ApiOkResponse({
    type: DictTypeResponseDto,
    description: '查询成功，返回字典类型完整字段',
  })
  @ApiNotFoundResponse({
    description: '字典类型不存在（含已软删除）',
    schema: {
      example: errExample(ErrorCode.DICT_TYPE_NOT_FOUND, '字典类型不存在'),
    },
  })
  async findType(
    @Param() param: DictTypeParamDto,
  ): Promise<DictTypeResponseDto> {
    return this.dictService.findType(BigInt(param.id));
  }

  @Post('dict-types')
  @RequirePermission('dict:create')
  @ApiOperation({
    summary: '新建字典类型',
    description:
      '编码全局唯一（不区分软删除的旧行——生成列只给未删除行建唯一索引）。' +
      '状态不传时为 1（启用）。',
  })
  @ApiCreatedResponse({
    type: DictTypeResponseDto,
    description: '创建成功，返回新建的字典类型',
  })
  @ApiConflictResponse({
    description: '字典类型编码已存在',
    schema: {
      example: errExample(ErrorCode.DICT_TYPE_CODE_TAKEN, '字典类型编码已存在'),
    },
  })
  async createType(
    @Body() dto: CreateDictTypeDto,
  ): Promise<DictTypeResponseDto> {
    return this.dictService.createType(dto);
  }

  @Put('dict-types/:id')
  @RequirePermission('dict:update')
  @ApiOperation({
    summary: '修改字典类型',
    description:
      '全量替换语义：name 必填；省略的字段表示保持原值（规范 DTO-13）。',
  })
  @ApiOkResponse({
    type: DictTypeResponseDto,
    description: '修改成功，返回更新后的字典类型',
  })
  @ApiNotFoundResponse({
    description: '字典类型不存在（含已软删除）',
    schema: {
      example: errExample(ErrorCode.DICT_TYPE_NOT_FOUND, '字典类型不存在'),
    },
  })
  @ApiConflictResponse({
    description: '字典类型编码已存在',
    schema: {
      example: errExample(ErrorCode.DICT_TYPE_CODE_TAKEN, '字典类型编码已存在'),
    },
  })
  async updateType(
    @Param() param: DictTypeParamDto,
    @Body() dto: UpdateDictTypeDto,
  ): Promise<DictTypeResponseDto> {
    return this.dictService.updateType(BigInt(param.id), dto);
  }

  @Delete('dict-types/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('dict:delete')
  @ApiOperation({
    summary: '删除字典类型',
    description:
      '软删除。**类型下还有字典项时拒绝删除**——先移走或删掉项再删类型，' +
      '否则下拉会凭空变成空数组。',
  })
  @ApiOkResponse({ description: '删除成功（响应体为空）' })
  @ApiNotFoundResponse({
    description: '字典类型不存在（含已软删除）',
    schema: {
      example: errExample(ErrorCode.DICT_TYPE_NOT_FOUND, '字典类型不存在'),
    },
  })
  @ApiConflictResponse({
    description: '该字典类型下还有字典项',
    schema: {
      example: errExample(
        ErrorCode.DICT_TYPE_HAS_ITEMS,
        '该字典类型下还有字典项，请先移走或删除',
      ),
    },
  })
  async deleteType(@Param() param: DictTypeParamDto): Promise<void> {
    await this.dictService.deleteType(BigInt(param.id));
  }

  // ── 字典项 ──────────────────────────────────────────────────

  @Get('dict-items')
  @RequirePermission('dict:list')
  @ApiOperation({
    summary: '查询字典项列表（分页）',
    description:
      '下拉数据源与字典项管理页共用。按 dictTypeId 或 dictTypeCode 过滤到某个类型' +
      '（前端手上通常是编码），再按文案模糊筛选。' +
      '同类型内按 sortOrder 升序、id 升序返回。传了不存在的编码返回空列表。',
  })
  @ApiOkResponse({
    type: DictItemPageResponseDto,
    description: '查询成功；没有命中时 list 为 []、total 为 0',
  })
  async findItems(
    @Query() query: QueryDictItemDto,
  ): Promise<DictItemPageResponseDto> {
    return this.dictService.findItems(query);
  }

  @Post('dict-items')
  @RequirePermission('dict:create')
  @ApiOperation({
    summary: '新建字典项',
    description:
      '所属类型必须存在；同类型内 value 唯一。label 是给人看的，value 是存进业务表的。',
  })
  @ApiCreatedResponse({
    type: DictItemResponseDto,
    description: '创建成功，返回新建的字典项',
  })
  @ApiNotFoundResponse({
    description: '所属字典类型不存在',
    schema: {
      example: errExample(ErrorCode.DICT_TYPE_NOT_FOUND, '字典类型不存在'),
    },
  })
  @ApiConflictResponse({
    description: '同字典类型下已存在相同的字典值',
    schema: {
      example: errExample(
        ErrorCode.DICT_ITEM_VALUE_TAKEN,
        '同字典类型下已存在相同的字典值',
      ),
    },
  })
  async createItem(
    @Body() dto: CreateDictItemDto,
  ): Promise<DictItemResponseDto> {
    return this.dictService.createItem(dto);
  }

  @Put('dict-items/:id')
  @RequirePermission('dict:update')
  @ApiOperation({
    summary: '修改字典项',
    description:
      '全量替换语义：label 必填；省略的字段表示保持原值。' +
      '所属类型不可改——搬家等于删旧建新，改外键会让「同类型内 value 唯一」的语义跟着漂。',
  })
  @ApiOkResponse({
    type: DictItemResponseDto,
    description: '修改成功，返回更新后的字典项',
  })
  @ApiNotFoundResponse({
    description: '字典项不存在（含已软删除）',
    schema: {
      example: errExample(ErrorCode.DICT_ITEM_NOT_FOUND, '字典项不存在'),
    },
  })
  @ApiConflictResponse({
    description: '同字典类型下已存在相同的字典值',
    schema: {
      example: errExample(
        ErrorCode.DICT_ITEM_VALUE_TAKEN,
        '同字典类型下已存在相同的字典值',
      ),
    },
  })
  async updateItem(
    @Param() param: DictItemParamDto,
    @Body() dto: UpdateDictItemDto,
  ): Promise<DictItemResponseDto> {
    return this.dictService.updateItem(BigInt(param.id), dto);
  }

  @Delete('dict-items/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('dict:delete')
  @ApiOperation({
    summary: '删除字典项',
    description: '软删除。已存进业务表的 value 不受影响——字典只管展示文案。',
  })
  @ApiOkResponse({ description: '删除成功（响应体为空）' })
  @ApiNotFoundResponse({
    description: '字典项不存在（含已软删除）',
    schema: {
      example: errExample(ErrorCode.DICT_ITEM_NOT_FOUND, '字典项不存在'),
    },
  })
  async deleteItem(@Param() param: DictItemParamDto): Promise<void> {
    await this.dictService.deleteItem(BigInt(param.id));
  }
}
