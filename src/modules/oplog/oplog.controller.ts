import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorCode } from '../../common/constants/error-code';
import { errExample } from '../../common/dto/err-example';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { OpLogService } from './oplog.service';
import {
  OpLogPageResponseDto,
  OpLogParamDto,
  QueryOpLogDto,
} from './dto/oplog.dto';
import { OpLogResponseDto } from './dto/oplog-response.dto';

@ApiTags('操作日志')
@Controller('op-logs')
export class OpLogController {
  constructor(private readonly opLogService: OpLogService) {}

  @Get()
  @RequirePermission('oplog:list')
  @ApiOperation({
    summary: '查询操作日志列表（分页）',
    description:
      '运维审计的主视图，按发生时间倒序返回。**没有写接口**：这张表是 append-only 的，' +
      'Prisma 扩展直接拒掉 update / delete，不在应用层「约定不许删」。' +
      '写入走 OpLogService.record()，由各业务模块在变更发生后调用。',
  })
  @ApiOkResponse({
    type: OpLogPageResponseDto,
    description: '查询成功；没有命中时 list 为 []、total 为 0',
  })
  async findPage(@Query() query: QueryOpLogDto): Promise<OpLogPageResponseDto> {
    return this.opLogService.findPage(query);
  }

  @Get(':id')
  @RequirePermission('oplog:list')
  @ApiOperation({
    summary: '查询操作日志详情',
    description:
      '带上变更前 / 变更后快照。快照由写入方决定——只有更新与删除才有 before，' +
      '只有新建与更新才有 after，日志本身不知道业务对象长什么样。',
  })
  @ApiOkResponse({
    type: OpLogResponseDto,
    description: '查询成功，返回操作日志完整字段',
  })
  @ApiNotFoundResponse({
    description: '操作日志不存在',
    schema: {
      example: errExample(ErrorCode.OP_LOG_NOT_FOUND, '操作日志不存在'),
    },
  })
  async findOne(@Param() param: OpLogParamDto): Promise<OpLogResponseDto> {
    return this.opLogService.findOne(BigInt(param.id));
  }
}
