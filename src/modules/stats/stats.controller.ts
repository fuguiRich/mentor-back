import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DataScope } from '../../common/decorators/data-scope.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ErrorCode } from '../../common/constants/error-code';
import { errExample } from '../../common/dto/err-example';
import type { RequestUser } from '../../common/context/request-context';
import { AppointmentStatsResponseDto } from './dto/appointment-stats.dto';
import { AssessmentStatsResponseDto } from './dto/assessment-stats.dto';
import { WorkbenchResponseDto } from './dto/workbench.dto';
import { GuidanceStatsResponseDto } from './dto/guidance-stats.dto';
import { MentorStatsResponseDto } from './dto/mentor-stats.dto';
import { StatsQueryDto } from './dto/stats-query.dto';
import { StatsService } from './stats.service';

/**
 * 统计报表（P4）。本任务一条路由：`GET /stats/mentors`。
 *
 * 全部统计接口都是**只读**：不得在统计服务里写任何表（`StatsRepository` 只有读方法）。
 */
@ApiTags('统计')
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get('mentors')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('stats:mentor')
  // 天花板放 `all`，由 Service 按调用者的有效范围收窄。
  // 用 `dept` 会把双创学院（`all`）压成本部门——它就看不到全校统计了。
  @DataScope('all')
  @ApiOperation({
    summary: '导师资源库统计（§4.1）',
    description:
      '统计项：入驻导师总数、校内 / 校外导师数、各指导方向分布、审核通过 / 未通过数、' +
      '活跃 / 非活跃导师数。**二级学院只统计本院；双创学院可按学院 / 全校统计**。' +
      '时间维度：`period`（学期 `YYYY-S`，或历史四位年份）或 `from` + `to`（`YYYY-MM-DD`，闭区间）**二选一**，' +
      '都不传按当前学期；两者同时传或 `from`/`to` 只给一个 → **400 / 10001**。' +
      '`deptId` 只有双创学院能传，学院管理员传了 → **403 / 10003**。' +
      '`total` / `internal` / `external` / `active` / `inactive` 只算**生效档案**；' +
      '`byStatus` 是全部 6 个状态的全量分布。`active` = 生效且周期内有 ≥1 条 ' +
      '`status = 6` 的预约（R68）。',
  })
  @ApiOkResponse({
    type: MentorStatsResponseDto,
    description: '统计结果（200）',
  })
  @ApiBadRequestResponse({
    description:
      'period 与 from/to 同时出现、from/to 只给一个、from 晚于 to、日期格式错（400 / 10001）',
    schema: { example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败') },
  })
  @ApiForbiddenResponse({
    description: '学院管理员传了 deptId（403 / 10003）或缺权限码 stats:mentor',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async mentors(
    @Query() query: StatsQueryDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<MentorStatsResponseDto> {
    return this.statsService.mentorStats(query, caller);
  }

  @Get('appointments')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('stats:appointment')
  @DataScope('all')
  @ApiOperation({
    summary: '师生预约情况统计（§4.2 / §5.3）',
    description:
      '按**导师所在部门**统计（本院导师收到的预约），不是按申请人部门。' +
      '时间维度用 `createdAt`（预约发起时间）。' +
      '`byStatus` 列全 10 个状态（缺项补 0）。两个比率：' +
      '`acceptanceRate`（预约成功率）= `count(status ∈ {1..6}) / count(all)`；' +
      '`completionRate`（指导完成率）= `count(6) / count(status ∈ {6,7,8,9})`。' +
      '**分母为 0 时返回 `null`，不是 0**。' +
      '`failedPairs` 列出 `7/8/9` 达到阈值（`SysConfig` 的 `stats.failed_pair_threshold`，' +
      '默认 3）的师生对，按失败数倒序、最多 50 条（§5.3 的线下协调名单）。',
  })
  @ApiOkResponse({
    type: AppointmentStatsResponseDto,
    description: '统计结果（200）',
  })
  @ApiBadRequestResponse({
    description: '时间维度参数非法（400 / 10001）',
    schema: { example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败') },
  })
  @ApiForbiddenResponse({
    description:
      '学院管理员传了 deptId（403 / 10003）或缺权限码 stats:appointment',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async appointments(
    @Query() query: StatsQueryDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AppointmentStatsResponseDto> {
    return this.statsService.appointmentStats(query, caller);
  }

  @Get('guidance')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('stats:guidance')
  @DataScope('all')
  @ApiOperation({
    summary: '指导工作统计（§4.6 / §3.7）',
    description:
      '按导师 / 学院 / 全校三个维度统计**指导次数、时长、学生数、成果数**。' +
      '口径与考核指标一致：只算 `appointment.status = 6` 且 `actualTime` 在区间内的记录。' +
      '导师视角只放本人；`mentorId` 传别人的 → **403 / 10003**（不静默改成自己）。' +
      '**顶层 5 个合计与 `byType` 是全量口径**，`byMentor` 只是分页明细（`page` / `pageSize`）。' +
      '`byType` 列全 1-5 五条（缺项补 0）。',
  })
  @ApiOkResponse({
    type: GuidanceStatsResponseDto,
    description: '统计结果（200）',
  })
  @ApiBadRequestResponse({
    description: '时间维度 / 类型 / 分页参数非法（400 / 10001）',
    schema: { example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败') },
  })
  @ApiForbiddenResponse({
    description:
      '导师传了别人的 mentorId 或学院传了 deptId（403 / 10003）或缺权限码',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async guidance(
    @Query() query: StatsQueryDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<GuidanceStatsResponseDto> {
    return this.statsService.guidanceStats(query, caller);
  }

  @Get('workbench/:mentorId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('stats:guidance')
  @DataScope('all')
  @ApiOperation({
    summary: '导师个人工作台（§3.6）',
    description:
      '导师看自己的：待确认 / 已确认待指导 / 待学生确认三个计数、评价汇总、' +
      '当前学期考核摘要、归档条目数。**全部实时值**，不读冻结快照。' +
      '可见性：导师本人 / 覆盖该导师所在部门的管理员；其余 → **403 / 10003**。' +
      '档案不存在 → **404 / 31102**。',
  })
  @ApiOkResponse({ type: WorkbenchResponseDto, description: '工作台（200）' })
  @ApiForbiddenResponse({
    description: '超出数据范围（403 / 10003）或缺权限码 stats:guidance',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  @ApiNotFoundResponse({
    description: '导师档案不存在（404 / 31102）',
    schema: {
      example: errExample(
        ErrorCode.MENTOR_PROFILE_NOT_FOUND,
        '导师专业档案不存在',
      ),
    },
  })
  async workbench(
    @Param('mentorId') mentorId: string,
    @CurrentUser() caller: RequestUser,
  ): Promise<WorkbenchResponseDto> {
    return this.statsService.workbench(BigInt(mentorId), caller);
  }

  @Get('assessments')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('stats:assessment')
  @DataScope('all')
  @ApiOperation({
    summary: '全校考核等级分布（§6.3 / §6.8）',
    description:
      '**`period` 必填**（考核分布脱离周期没有意义）。' +
      '**只统计 `status = 2 APPROVED`** 的考核：未终评的没有等级，算进来会让' +
      '「不合格率」随时间自己变化。' +
      '按学院 / 导师类型（校内 / 校外）/ 指导方向三个维度统计' +
      '优秀 / 合格 / 不合格的分布。' +
      '`byDept` 与 `byMentorType` 各行 `total` 之和**等于** `total`；' +
      '`byResearchField` 的会**大于** `total`——一个导师多个方向时在每个方向各计一次。',
  })
  @ApiOkResponse({
    type: AssessmentStatsResponseDto,
    description: '统计结果（200）',
  })
  @ApiBadRequestResponse({
    description: '缺 period / period 不是 YYYY-S（400 / 10001）',
    schema: { example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败') },
  })
  @ApiForbiddenResponse({
    description:
      '学院管理员传了 deptId（403 / 10003）或缺权限码 stats:assessment',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async assessments(
    @Query() query: StatsQueryDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AssessmentStatsResponseDto> {
    return this.statsService.assessmentStats(query, caller);
  }
}
