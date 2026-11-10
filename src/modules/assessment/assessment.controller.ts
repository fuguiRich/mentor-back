import {
  Body,
  Controller,
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
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
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
import { AssessmentService } from './assessment.service';
import { AssessmentParamDto } from './dto/assessment-param.dto';
import { AppealParamDto } from './dto/appeal-param.dto';
import {
  AppealListResponseDto,
  AppealResponseDto,
  QueryAppealDto,
} from './dto/appeal-response.dto';
import { CreateAppealDto } from './dto/create-appeal.dto';
import { HandleAppealDto } from './dto/handle-appeal.dto';
import { AssessmentResponseDto } from './dto/assessment-response.dto';
import { CollegeReviewDto } from './dto/college-review.dto';
import { CreateAssessmentDto } from './dto/create-assessment.dto';
import { FinalReviewDto } from './dto/final-review.dto';
import { QueryAssessmentDto } from './dto/query-assessment.dto';
import { AssessmentListResponseDto } from './dto/assessment-response.dto';
import {
  AssessmentRuleResponseDto,
  UpdateAssessmentRuleDto,
} from './dto/assessment-rule.dto';

/**
 * 考核（P3 Task 39 起）——本任务两条路由：
 *
 * - `POST /assessments`（学院为本院导师开考核，`assessment:evaluate`，`@DataScope('dept')`）；
 * - `POST /assessments/:id/college-review`（学院提交初评，同码同范围）。
 *
 * 状态机见 `assessment.constants.ts`；冻结时机见 `AssessmentService.collegeReview`。
 */
@ApiTags('考核')
@Controller('assessments')
export class AssessmentController {
  constructor(private readonly assessmentService: AssessmentService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('assessment:evaluate')
  @DataScope('dept')
  @ApiOperation({
    summary: '开一个考核周期（二级学院管理员）',
    description:
      '学院为本院一位已生效的导师开一个考核周期，落 `status = 0 DRAFT`。' +
      '请求体 `{ mentorId, period }`：`period` 只接受**学期 `YYYY-S`**（S=1/2，P5-R5）。' +
      '守卫：导师档案不存在 / 未生效 → **404 / 31102**；不在本院 → **403 / 10003**；' +
      '同导师同周期已存在 → **409 / 35003**。',
  })
  @ApiBody({ type: CreateAssessmentDto })
  @ApiCreatedResponse({
    type: AssessmentResponseDto,
    description: '创建成功（201），`status = 0`，指标为实时试算',
  })
  @ApiBadRequestResponse({
    description:
      'mentorId 非数字 ID / period 不是 YYYY-S / 未知字段（400 / 10001）',
    schema: { example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败') },
  })
  @ApiForbiddenResponse({
    description: '导师不在本院（403 / 10003）或缺权限码 assessment:evaluate',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  @ApiNotFoundResponse({
    description: '导师档案不存在 / 未生效（404 / 31102）',
    schema: {
      example: errExample(
        ErrorCode.MENTOR_PROFILE_NOT_FOUND,
        '导师专业档案不存在',
      ),
    },
  })
  @ApiConflictResponse({
    description: '同导师同周期已有考核（409 / 35003）',
    schema: {
      example: errExample(
        ErrorCode.ASSESSMENT_PERIOD_TAKEN,
        '该导师本周期已有考核',
      ),
    },
  })
  async create(
    @Body() dto: CreateAssessmentDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AssessmentResponseDto> {
    return this.assessmentService.create(dto, caller);
  }

  @Post(':id/college-review')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('assessment:evaluate')
  @DataScope('dept')
  @ApiOperation({
    summary: '提交初评（二级学院管理员）',
    description:
      '学院填写初评等级与意见，**`0 DRAFT | 3 RETURNED → 1 COLLEGE_SUBMITTED`**。' +
      '请求体 `{ grade, comment }`：`grade` 1 优秀 / 2 合格 / 3 不合格（**人工填**，' +
      '不由分数推导，R50），`comment` 1-1000 字。**没有草稿态**（R53）：提交即冻结。' +
      '同一事务里把 6 个指标 + `compositeScore` + `weights` 整组落库（R55），' +
      '之后学生再写评价也不会改动它。' +
      '守卫：考核不存在 → **404 / 35001**；不在本院 → **403 / 10003**；' +
      '出发态不是 `0` / `3` → **409 / 35002**。',
  })
  @ApiBody({ type: CollegeReviewDto })
  @ApiOkResponse({
    type: AssessmentResponseDto,
    description: '提交成功（200），`status = 1`，指标为冻结值',
  })
  @ApiBadRequestResponse({
    description: 'grade 越界 / comment 长度越界 / 未知字段（400 / 10001）',
    schema: { example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败') },
  })
  @ApiForbiddenResponse({
    description: '考核所属导师不在本院（403 / 10003）或缺权限码',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  @ApiNotFoundResponse({
    description: '考核不存在（404 / 35001）',
    schema: {
      example: errExample(ErrorCode.ASSESSMENT_NOT_FOUND, '考核不存在'),
    },
  })
  @ApiConflictResponse({
    description: '出发态不是 0 / 3（409 / 35002）',
    schema: {
      example: errExample(
        ErrorCode.ASSESSMENT_TRANSITION_INVALID,
        '当前状态不允许该操作',
      ),
    },
  })
  async collegeReview(
    @Param() params: AssessmentParamDto,
    @Body() dto: CollegeReviewDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AssessmentResponseDto> {
    return this.assessmentService.collegeReview(BigInt(params.id), dto, caller);
  }

  @Post(':id/final-review')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('assessment:finalize')
  @DataScope('all')
  @ApiOperation({
    summary: '考核终评（双创学院管理员）',
    description:
      '双创学院审核学院提交的初评结果，**`1 COLLEGE_SUBMITTED → 2 APPROVED | 3 RETURNED`**。' +
      '请求体 `{ decision, grade?, comment }`：`decision` 是 `approve` 或 `return`，' +
      '`comment` 1-1000 字（**两个决定都必填**）。' +
      '**`approve` 必须带 `grade`**（1 优秀 / 2 合格 / 3 不合格），**`return` 必须不带**' +
      '（带了 → 400 / 10001：退回还定级是自相矛盾的输入）。' +
      '终评等级与初评等级**互不覆盖**（R54）：`finalGrade` 可以不同于 `collegeGrade`；' +
      '退回时 `finalGrade` 置 `null`。' +
      '守卫：考核不存在 → **404 / 35001**；`status ≠ 1` → **409 / 35002**。',
  })
  @ApiBody({ type: FinalReviewDto })
  @ApiOkResponse({
    type: AssessmentResponseDto,
    description:
      '终评成功（200）：`approve` → `status = 2`；`return` → `status = 3`',
  })
  @ApiBadRequestResponse({
    description:
      'decision 不是 approve / return、approve 缺 grade、return 带 grade、' +
      'comment 长度越界、未知字段（400 / 10001）',
    schema: { example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败') },
  })
  @ApiForbiddenResponse({
    description: '缺权限码 assessment:finalize（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  @ApiNotFoundResponse({
    description: '考核不存在（404 / 35001）',
    schema: {
      example: errExample(ErrorCode.ASSESSMENT_NOT_FOUND, '考核不存在'),
    },
  })
  @ApiConflictResponse({
    description: '状态不是 1 COLLEGE_SUBMITTED（409 / 35002）',
    schema: {
      example: errExample(
        ErrorCode.ASSESSMENT_TRANSITION_INVALID,
        '当前状态不允许该操作',
      ),
    },
  })
  async finalReview(
    @Param() params: AssessmentParamDto,
    @Body() dto: FinalReviewDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AssessmentResponseDto> {
    return this.assessmentService.finalReview(BigInt(params.id), dto, caller);
  }

  /**
   * **路由顺序**：`rules` 必须在 `@Get(':id')` 之前声明，否则会被当成 id。
   */
  @Get('rules')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('assessment:list')
  @DataScope('all')
  @ApiOperation({
    summary: '读取考核评分规则（§6.6）',
    description:
      '当前生效的三个权重（归一化后）与两个目标值。权重缺省 0.4 / 0.4 / 0.2，' +
      '目标值缺省 10 / 5。',
  })
  @ApiOkResponse({
    type: AssessmentRuleResponseDto,
    description: '规则（200）',
  })
  async rules(): Promise<AssessmentRuleResponseDto> {
    return this.assessmentService.getRules();
  }

  @Put('rules')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('assessment:rule-manage')
  @DataScope('all')
  @ApiOperation({
    summary: '更新考核评分规则（双创学院管理员，§6.6）',
    description:
      '请求体 `{ weights: { review, workload, achievement }, targets?: ' +
      '{ workload?, achievement? } }`。三个权重必须非负且和大于 0；' +
      '和不为 1 时按比例归一化并回显 `normalized = true`。目标值必须是 >= 1 的整数。' +
      '非法输入 → **400 / 10001**。规则只影响**之后**新建的考核：已提交的考核' +
      '冻结的是提交时的权重（R55）。',
  })
  @ApiBody({ type: UpdateAssessmentRuleDto })
  @ApiOkResponse({
    type: AssessmentRuleResponseDto,
    description: '更新后的规则（200）',
  })
  @ApiBadRequestResponse({
    description: '权重非法 / 目标值小于 1（400 / 10001）',
    schema: { example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败') },
  })
  @ApiForbiddenResponse({
    description: '缺权限码 assessment:rule-manage（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async updateRules(
    @Body() dto: UpdateAssessmentRuleDto,
  ): Promise<AssessmentRuleResponseDto> {
    return this.assessmentService.updateRules(dto);
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('assessment:list')
  @DataScope('all')
  @ApiOperation({
    summary: '考核列表（三种视角）',
    description:
      '导师只看自己的；二级学院看本院；双创学院看全校。查询参数 ' +
      '`period?` / `status?` / `grade?` / `page` / `pageSize`。' +
      '`grade` 按「终评等级优先、未终评的看初评」匹配。' +
      '**列表只回冻结值**：`status = 0` 的行指标列还没冻结（`reviewAvg` 为 null、' +
      '计数为 0、`compositeScore` 为 `"0.00"`）；实时试算只在详情里做。' +
      '按 `period DESC, id DESC` 排序。',
  })
  @ApiOkResponse({
    type: AssessmentListResponseDto,
    description: '考核列表（`list` / `total` / `page` / `pageSize`）',
  })
  @ApiForbiddenResponse({
    description: '缺权限码 assessment:list（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async list(
    @Query() query: QueryAssessmentDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AssessmentListResponseDto> {
    return this.assessmentService.list(query, caller);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('assessment:list')
  @DataScope('all')
  @ApiOperation({
    summary: '考核详情',
    description:
      '可见性：导师本人 / 数据范围覆盖**该导师所在部门**的管理员；其余 → **403 / 10003**。' +
      '考核不存在 → **404 / 35001**。' +
      '`status = 0` 回**实时试算**（按当前配置现算），`status ≥ 1` 回**提交初评时冻结的值**（R55）——' +
      '所以「提交之后学生再写评价」不会改动已提交的初评数字。',
  })
  @ApiOkResponse({ type: AssessmentResponseDto, description: '详情（200）' })
  @ApiForbiddenResponse({
    description: '超出数据范围（403 / 10003）或缺权限码 assessment:list',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  @ApiNotFoundResponse({
    description: '考核不存在（404 / 35001）',
    schema: {
      example: errExample(ErrorCode.ASSESSMENT_NOT_FOUND, '考核不存在'),
    },
  })
  async findOne(
    @Param() params: AssessmentParamDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AssessmentResponseDto> {
    return this.assessmentService.findById(BigInt(params.id), caller);
  }

  @Post(':id/appeals')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('assessment:appeal')
  @DataScope('self')
  @ApiOperation({
    summary: '对考核结果申诉（导师）',
    description:
      '导师对**已生效**的考核结果提交申诉说明（§3.8）。请求体 `{ reason }`：1-1000 字。' +
      '**不修改考核等级**（R56）——申诉只是「我不同意，请复核」；' +
      '但考核状态会从 `2 已生效` 推进到 `4 申诉中`。' +
      '守卫：考核不存在 → **404 / 35001**；不是该导师本人 → **403 / 10003**；' +
      '`status ≠ 2 APPROVED` → **409 / 35006**；已有待处理申诉 → **409 / 35005**。',
  })
  @ApiBody({ type: CreateAppealDto })
  @ApiCreatedResponse({
    type: AppealResponseDto,
    description: '提交成功（201），`status = 0`',
  })
  @ApiBadRequestResponse({
    description: 'reason 缺失 / 为空 / 超过 1000 字 / 未知字段（400 / 10001）',
    schema: { example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败') },
  })
  @ApiForbiddenResponse({
    description: '不是该导师本人（403 / 10003）或缺权限码 assessment:appeal',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  @ApiNotFoundResponse({
    description: '考核不存在（404 / 35001）',
    schema: {
      example: errExample(ErrorCode.ASSESSMENT_NOT_FOUND, '考核不存在'),
    },
  })
  @ApiConflictResponse({
    description: '考核未生效（409 / 35006）或已有待处理申诉（409 / 35005）',
    schema: {
      example: errExample(
        ErrorCode.ASSESSMENT_APPEAL_NOT_ALLOWED,
        '当前考核状态不允许申诉',
      ),
    },
  })
  async createAppeal(
    @Param() params: AssessmentParamDto,
    @Body() dto: CreateAppealDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AppealResponseDto> {
    return this.assessmentService.createAppeal(BigInt(params.id), dto, caller);
  }

  @Get(':id/appeals')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('assessment:list')
  @DataScope('all')
  @ApiOperation({
    summary: '考核的申诉列表',
    description:
      '可见性与考核详情同源：导师本人 / 覆盖该导师所在部门的管理员；其余 → **403 / 10003**。' +
      '按 `createdAt DESC, id DESC` 分页。考核不存在 → **404 / 35001**。',
  })
  @ApiOkResponse({
    type: AppealListResponseDto,
    description: '申诉列表（`list` / `total` / `page` / `pageSize`）',
  })
  @ApiForbiddenResponse({
    description: '超出数据范围（403 / 10003）或缺权限码 assessment:list',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  @ApiNotFoundResponse({
    description: '考核不存在（404 / 35001）',
    schema: {
      example: errExample(ErrorCode.ASSESSMENT_NOT_FOUND, '考核不存在'),
    },
  })
  async listAppeals(
    @Param() params: AssessmentParamDto,
    @Query() query: QueryAppealDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AppealListResponseDto> {
    return this.assessmentService.listAppeals(BigInt(params.id), query, caller);
  }

  @Post(':id/appeals/:appealId/handle')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('assessment:appeal-handle')
  @DataScope('all')
  @ApiOperation({
    summary: '处理考核申诉（双创学院管理员）',
    description:
      '请求体 `{ decision, reply }`：`decision` 是 `accept` 受理 / `reject` 驳回，' +
      '`reply` 1-1000 字（**两个决定都必填**）。' +
      '**不修改考核结果**（R56）：受理只表示已收到并会复核，不是重新定级。' +
      '守卫：考核不存在 → **404 / 35001**；申诉不存在 / 不属于该考核 → **404 / 35004**；' +
      '申诉状态不是 `0 PENDING` 或考核不在 `4 申诉中` → **409 / 35002**。' +
      '处理结果同步推进考核状态：受理 → `5 申诉已受理`，驳回 → `6 申诉已驳回`。',
  })
  @ApiBody({ type: HandleAppealDto })
  @ApiOkResponse({
    type: AppealResponseDto,
    description: '处理成功（200）：`accept` → `1`；`reject` → `2`',
  })
  @ApiBadRequestResponse({
    description:
      'decision 不是 accept / reject、reply 长度越界、未知字段（400 / 10001）',
    schema: { example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败') },
  })
  @ApiForbiddenResponse({
    description: '缺权限码 assessment:appeal-handle（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  @ApiNotFoundResponse({
    description: '考核不存在（404 / 35001）或申诉不存在（404 / 35004）',
    schema: {
      oneOf: [
        errExample(ErrorCode.ASSESSMENT_NOT_FOUND, '考核不存在'),
        errExample(ErrorCode.ASSESSMENT_APPEAL_NOT_FOUND, '考核申诉不存在'),
      ].map((example) => ({ example })),
    },
  })
  @ApiConflictResponse({
    description: '申诉已被处理过（409 / 35002）',
    schema: {
      example: errExample(
        ErrorCode.ASSESSMENT_TRANSITION_INVALID,
        '当前状态不允许该操作',
      ),
    },
  })
  async handleAppeal(
    @Param() params: AppealParamDto,
    @Body() dto: HandleAppealDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AppealResponseDto> {
    return this.assessmentService.handleAppeal(
      BigInt(params.id),
      BigInt(params.appealId),
      dto,
      caller,
    );
  }
}
