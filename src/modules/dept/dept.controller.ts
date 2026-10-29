import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorCode } from '../../common/constants/error-code';
import { errExample } from '../../common/dto/err-example';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { DeptService } from './dept.service';
import { DeptParamDto } from './dto/dept-param.dto';
import { QueryDeptDto } from './dto/query-dept.dto';
import { DeptResponseDto } from './dto/dept-response.dto';
import { DeptTreeResponseDto } from './dto/dept-tree-response.dto';

/**
 * 部门管理（Task 6b 收口后只读）。
 * `SysDept` 的写入归源系统：改名、挂树、软删都由 6a 的同步投影维护，
 * POST / PUT / DELETE 三条路由已删——组织信息不走手工录入。
 */
@ApiTags('部门管理')
@Controller('depts')
export class DeptController {
  constructor(private readonly deptService: DeptService) {}

  // tree 必须声明在 :id 之前。反过来写的话 /depts/tree 会被 :id 捕获，
  // 然后因为 'tree' 不是数字字符串而被校验管道拒绝，报 400 而不是返回树。
  @Get('tree')
  @RequirePermission('dept:list')
  @ApiOperation({
    summary: '查询部门树',
    description:
      '后台需要一次性拿到完整层级时调用，例如部门选择器、组织架构页。' +
      '默认返回全部未删除部门，按父子关系组装成树；' +
      '传 name 时先按名称模糊过滤，父节点不在过滤结果集中的部门会被提升为根节点，不会消失。',
  })
  @ApiOkResponse({
    type: [DeptTreeResponseDto],
    description: '查询成功，返回部门层级树；没有任何部门时为 []',
  })
  @ApiInternalServerErrorResponse({
    description: '数据异常：部门数据存在环，无法构建部门树',
    schema: {
      example: errExample(
        ErrorCode.INTERNAL_ERROR,
        '部门数据存在环，无法构建部门树',
      ),
    },
  })
  async findTree(@Query() query: QueryDeptDto): Promise<DeptTreeResponseDto[]> {
    return this.deptService.findTree(query.name);
  }

  @Get(':id')
  @RequirePermission('dept:list')
  @ApiOperation({
    summary: '查询部门详情',
    description:
      '部门详情页、编辑表单回填时调用，需要完整字段而不只是名称时用它。' +
      '已软删除的部门视同不存在，一律返回 404，不区分「从未存在」与「已删除」。',
  })
  @ApiOkResponse({
    type: DeptResponseDto,
    description: '查询成功，返回该部门的完整字段',
  })
  @ApiNotFoundResponse({
    description: '部门不存在（含已软删除）',
    schema: {
      example: errExample(ErrorCode.DEPT_NOT_FOUND, '部门不存在'),
    },
  })
  async findOne(@Param() params: DeptParamDto): Promise<DeptResponseDto> {
    return this.deptService.findOne(BigInt(params.id));
  }
}
