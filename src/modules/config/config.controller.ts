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
  ApiBadRequestResponse,
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
import { ConfigService } from './config.service';
import {
  ConfigPageResponseDto,
  ConfigParamDto,
  CreateConfigDto,
  QueryConfigDto,
  UpdateConfigDto,
} from './dto/config.dto';
import { ConfigResponseDto } from './dto/config-response.dto';

@ApiTags('系统配置')
@Controller('configs')
export class SysConfigController {
  constructor(private readonly configService: ConfigService) {}

  @Get()
  @RequirePermission('config:list')
  @ApiOperation({
    summary: '查询系统配置列表（分页）',
    description:
      '参数配置页的主视图。可按编码 / 名称 / 状态筛选，编码与名称是模糊匹配，' +
      '按编码升序返回。返回统一的分页结构 { list, total, page, pageSize }（规范 RES-06）。',
  })
  @ApiOkResponse({
    type: ConfigPageResponseDto,
    description: '查询成功；没有命中时 list 为 []、total 为 0',
  })
  async findPage(
    @Query() query: QueryConfigDto,
  ): Promise<ConfigPageResponseDto> {
    return this.configService.findPage(query);
  }

  @Get(':id')
  @RequirePermission('config:list')
  @ApiOperation({
    summary: '查询系统配置详情',
    description: '编辑表单回填用。',
  })
  @ApiOkResponse({
    type: ConfigResponseDto,
    description: '查询成功，返回配置完整字段',
  })
  @ApiNotFoundResponse({
    description: '配置不存在（含已软删除）',
    schema: {
      example: errExample(ErrorCode.CONFIG_NOT_FOUND, '系统配置不存在'),
    },
  })
  async findOne(@Param() param: ConfigParamDto): Promise<ConfigResponseDto> {
    return this.configService.findOne(BigInt(param.id));
  }

  @Post()
  @RequirePermission('config:create')
  @ApiOperation({
    summary: '新建系统配置',
    description:
      '编码全局唯一。value 与 valueType 必须相符——例如 valueType=number 时 ' +
      'value 必须是有限的十进制数（不接受 NaN / Infinity），valueType=boolean 时 ' +
      '只接受字面量 true / false。',
  })
  @ApiCreatedResponse({
    type: ConfigResponseDto,
    description: '创建成功，返回新建的配置',
  })
  @ApiConflictResponse({
    description: '系统配置编码已存在',
    schema: {
      example: errExample(ErrorCode.CONFIG_CODE_TAKEN, '系统配置编码已存在'),
    },
  })
  @ApiBadRequestResponse({
    description:
      '配置值与声明的类型不符（26104）。传了不在枚举里的 valueType 会被字段校验' +
      '先拦成 10001（data.fields 含 valueType）——26103 只在生效类型来自库里的' +
      '脏数据时才出现，新建路径碰不到。',
    schema: {
      example: errExample(
        ErrorCode.CONFIG_VALUE_MISMATCH,
        '配置值与声明的类型不符',
      ),
    },
  })
  async create(@Body() dto: CreateConfigDto): Promise<ConfigResponseDto> {
    return this.configService.create(dto);
  }

  @Put(':id')
  @RequirePermission('config:update')
  @ApiOperation({
    summary: '修改系统配置',
    description:
      '全量替换语义：name 与 value 必填；省略的字段表示保持原值（规范 DTO-13）。' +
      '改 valueType 时 value 必须同时给出且与新类型相符。',
  })
  @ApiOkResponse({
    type: ConfigResponseDto,
    description: '修改成功，返回更新后的配置',
  })
  @ApiNotFoundResponse({
    description: '配置不存在（含已软删除）',
    schema: {
      example: errExample(ErrorCode.CONFIG_NOT_FOUND, '系统配置不存在'),
    },
  })
  @ApiConflictResponse({
    description: '系统配置编码已存在',
    schema: {
      example: errExample(ErrorCode.CONFIG_CODE_TAKEN, '系统配置编码已存在'),
    },
  })
  @ApiBadRequestResponse({
    description:
      '配置值与声明的类型不符（26104）。传了不在枚举里的 valueType 会被字段校验' +
      '先拦成 10001；不传 valueType 时按**当前行**的类型校验，若那一列是脏的' +
      '（历史数据 / 手工改库留下的非法类型名）则为 26103。',
    schema: {
      example: errExample(
        ErrorCode.CONFIG_VALUE_MISMATCH,
        '配置值与声明的类型不符',
      ),
    },
  })
  async update(
    @Param() param: ConfigParamDto,
    @Body() dto: UpdateConfigDto,
  ): Promise<ConfigResponseDto> {
    return this.configService.update(BigInt(param.id), dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('config:delete')
  @ApiOperation({
    summary: '删除系统配置',
    description:
      '软删除。**已在用的配置码不要删**——业务代码按编码取值，删了之后取不到会静默回落到默认值，' +
      '而默认值往往不是你想要的生产值。要下线就停用（status=0）。',
  })
  @ApiOkResponse({ description: '删除成功（响应体为空）' })
  @ApiNotFoundResponse({
    description: '配置不存在（含已软删除）',
    schema: {
      example: errExample(ErrorCode.CONFIG_NOT_FOUND, '系统配置不存在'),
    },
  })
  async remove(@Param() param: ConfigParamDto): Promise<void> {
    await this.configService.remove(BigInt(param.id));
  }
}
