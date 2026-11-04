import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DataScope } from '../../common/decorators/data-scope.decorator';
import type { RequestUser } from '../../common/context/request-context';
import { ErrorCode } from '../../common/constants/error-code';
import { errExample, errExamples } from '../../common/dto/err-example';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { UpdateMentorProfileDto } from '../mentor/dto/mentor-profile.dto';
import { MentorApplicationService } from './mentor-application.service';
import { ReviewService, type ReviewRequestMeta } from './review.service';
import { MentorApplicationResponseDto } from './dto/mentor-application-response.dto';
import { SubmitOnboardDto } from './dto/submit-onboard.dto';
import {
  CollegeReviewDto,
  ScReviewDto,
  WithdrawApplicationDto,
} from './dto/review.dto';
import {
  MentorApplicationPageResponseDto,
  MentorApplicationParamDto,
  QueryMentorApplicationDto,
} from './dto/query-application.dto';

/**
 * 入驻申请（Task 13 提交；Task 14 审核 / 读入口；`type=2` 归 Task 15）——
 * 全部挂在本 controller 上，不另建。
 *
 * 提交的语义是「把**当时那一版**档案打包送审」：填报走 `PUT /mentor/profile`，
 * 这里**空 DTO**、不收任何字段——两处都收字段 = 两个写口写同一份数据，迟早分叉。
 *
 * 审核流（Task 14）：**二级学院 → 双创学院**两级审（Ruling #5）。
 * 权限码分流（不用角色名，Ruling #0.2）：`review-college` / `review-sc` /
 * `withdraw` / `list`；数据范围天花板逐路由不同（brief §0.3）：
 * college-review `'dept'`、sc-review `'all'`、withdraw `'self'`、
 * 列表 / 详情 `'all'`（详情在服务里按申请人部门判越权）。
 */
@ApiTags('入驻申请')
@Controller('mentor-applications')
export class MentorApplicationController {
  constructor(
    private readonly mentorApplicationService: MentorApplicationService,
    private readonly reviewService: ReviewService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('mentor-application:submit')
  @DataScope('self')
  @ApiOperation({
    summary: '提交入驻申请（打包当前档案送审）',
    description:
      '把**当前**导师专业档案打包成快照送审（`type=1 ONBOARD`）。**空请求体**——' +
      '填报走 `PUT /mentor/profile`，请求体出现任何字段（含 type / status / ' +
      'snapshot / personId）一律 **400 / 10001**（全局 forbidNonWhitelisted）。' +
      'applicantId / profileId 不来自入参：靠身份链解析（SysUser.username ↔ ' +
      'SyncPerson.login → personId → MentorProfile），只能提自己的。' +
      '**资格门**：`MentorProfile.status ∈ {0 DRAFT, 3 REJECTED}` 才能提交；' +
      '成功后档案推进到 **1 PENDING**（裁定 R52，与申请行同一次事务）。' +
      'status=2 报 **409 / 31101**（已入驻）；1 / 4 / 5 报 **409 / 31103**。' +
      '**提交即快照**：snapshot 存当时的填报内容（MentorProfileDraft，含推导的 ' +
      'mentorType），落库后永不改写——之后 PUT /mentor/profile 改档案不影响它。' +
      '申请行先落 1 SUBMITTED、同一事务内立刻推进到 2 COLLEGE_REVIEWING：' +
      '1 是状态机上的边不是可停留态，对外可见的终态恒为 2。',
  })
  @ApiBody({
    type: SubmitOnboardDto,
    description:
      '**空请求体**（SubmitOnboardDto 无字段）。提交的语义是「把当前档案打包送审」，' +
      '任何字段一律 400 / 10001',
  })
  @ApiCreatedResponse({
    type: MentorApplicationResponseDto,
    description:
      '提交成功（201）。申请行 status=2 COLLEGE_REVIEWING，MentorProfile.status → 1 PENDING',
  })
  @ApiNotFoundResponse({
    description: '未建档就提交（404 / 31102）',
    schema: {
      example: errExample(
        ErrorCode.MENTOR_PROFILE_NOT_FOUND,
        '导师专业档案不存在',
      ),
    },
  })
  @ApiForbiddenResponse({
    description: '调用者不是导师（403 / 10003）',
    schema: {
      example: errExample(
        ErrorCode.FORBIDDEN,
        '只有导师（internalMentor / externalMentor / teacher）有专业档案',
      ),
    },
  })
  @ApiConflictResponse({
    description: '档案状态不允许提交（409）',
    schema: {
      oneOf: errExamples(
        [
          ErrorCode.MENTOR_ALREADY_ONBOARDED,
          '导师已入驻，不能重复提交入驻申请',
        ],
        [
          ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE,
          '导师档案当前状态不允许提交入驻申请',
        ],
      ).map((example) => ({ example })),
    },
  })
  async submitOnboard(
    @Body() dto: SubmitOnboardDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<MentorApplicationResponseDto> {
    // dto 只为触发空白名单校验（任何字段 → 400）；提交载荷全部由服务端定死，
    // 服务端签名里根本没有它（eslint 的 after-used 规则不查前位未用参数）
    return this.mentorApplicationService.submitOnboard(caller);
  }

  @Post('profile-change')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('mentor-application:submit')
  @DataScope('self')
  @ApiOperation({
    summary: '提交信息修改申请（把拟改字段打包送审）',
    description:
      '已入驻导师（`MentorProfile.status = 2`）改自己的 7 个可填报字段——' +
      '**不能直接落库**，打包成提案走两级审（二级学院 → 双创学院），' +
      '生效那一刻才写回 `MentorProfile`（R55：status=2 时 `PUT /mentor/profile` ' +
      '已关）。请求体是 Task 11 的 `UpdateMentorProfileDto`（复用，不复制）：' +
      '**增量语义**——省略 = 不动、显式 null = 清空、researchFields 传数组 = 整体' +
      '替换；`snapshot` 存的是**合并到当前档案之后的完整样子**（R67），落库后' +
      '永不改写。type=2 服务端定死；snapshot / applicantId / profileId / status ' +
      '不收（未知字段 → 400 / 10001）。**资格门**：status ≠ 2 一律 409 / 31103' +
      '（0/3 点名「改草稿走 PUT /mentor/profile」）；无档案 404 / 31102；' +
      '**在审查重**（R58：本人有 status ∈ {1,2,4,5} 的申请）→ 409 / 31106。' +
      'type=2 的任何流转**不碰 `MentorProfile.status`**——被拒不降级（§0.5）。',
  })
  @ApiBody({
    type: UpdateMentorProfileDto,
    description:
      '拟改字段（增量语义，同 PUT /mentor/profile 的入参白名单）。' +
      'type / snapshot / applicantId / profileId / status 一律 400 / 10001',
  })
  @ApiCreatedResponse({
    type: MentorApplicationResponseDto,
    description:
      '提交成功（201）。申请行 type=2、status=2 COLLEGE_REVIEWING，' +
      'MentorProfile.status 仍为 2（不碰）',
  })
  @ApiForbiddenResponse({
    description: '调用者不是导师（403 / 10003）',
    schema: {
      example: errExample(
        ErrorCode.FORBIDDEN,
        '只有导师（internalMentor / externalMentor / teacher）有专业档案',
      ),
    },
  })
  @ApiNotFoundResponse({
    description: '未建档就提交（404 / 31102）',
    schema: {
      example: errExample(
        ErrorCode.MENTOR_PROFILE_NOT_FOUND,
        '导师专业档案不存在',
      ),
    },
  })
  @ApiConflictResponse({
    description: '档案状态不允许提交 / 已有在审申请（409）',
    schema: {
      oneOf: errExamples(
        [
          ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE,
          '导师档案还是草稿，改草稿走 PUT /mentor/profile',
        ],
        [
          ErrorCode.MENTOR_APPLICATION_IN_FLIGHT,
          '已有在审的申请，不能重复提交',
        ],
      ).map((example) => ({ example })),
    },
  })
  async submitProfileChange(
    @Body() dto: UpdateMentorProfileDto,
    @CurrentUser() caller: RequestUser,
    @Req() req: Request,
  ): Promise<MentorApplicationResponseDto> {
    return this.mentorApplicationService.submitProfileChange(
      dto,
      caller,
      toRequestMeta(req),
    );
  }

  @Get()
  @RequirePermission('mentor-application:list')
  @DataScope('all')
  @ApiOperation({
    summary: '入驻申请列表（分页，可按 status / type 筛）',
    description:
      '数据范围天花板 **`all`**——不夹窄，角色的 data_scope 自己收窄：' +
      'college_admin（deptAndChildren）只出本院**及下级**导师的申请，' +
      "sc_admin（all）出全校。`@DataScope('dept')` 会把双创学院夹成本院，禁。" +
      '行级范围不来自入参（不收任何范围参数）。',
  })
  @ApiOkResponse({
    type: MentorApplicationPageResponseDto,
    description: '分页列表（按 id 倒序，新申请在前）',
  })
  async findPage(
    @Query() query: QueryMentorApplicationDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<MentorApplicationPageResponseDto> {
    return this.mentorApplicationService.findPage(query, caller);
  }

  @Get(':id')
  @RequirePermission('mentor-application:list')
  @DataScope('all')
  @ApiOperation({
    summary: '入驻申请详情',
    description:
      '天花板 **`all`** + 服务里 `assertDeptVisible(filter, 申请人部门)`：' +
      '单条按院系判越权——越权是 **403 / 10003**（不是 404，要能区分「没权限」' +
      '和「不存在」）；`:id` 不存在或已软删是 **404 / 31104**。',
  })
  @ApiOkResponse({
    type: MentorApplicationResponseDto,
    description: '详情（含 snapshot 与两级审核记录）',
  })
  @ApiNotFoundResponse({
    description: '申请不存在或已软删（404 / 31104）',
    schema: {
      example: errExample(
        ErrorCode.MENTOR_APPLICATION_NOT_FOUND,
        '入驻申请不存在',
      ),
    },
  })
  @ApiForbiddenResponse({
    description: '申请人部门不在数据范围内（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async findOne(
    @Param() param: MentorApplicationParamDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<MentorApplicationResponseDto> {
    return this.mentorApplicationService.findOne(BigInt(param.id), caller);
  }

  @Post(':id/college-review')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('mentor-application:review-college')
  @DataScope('dept')
  @ApiOperation({
    summary: '二级学院审核（通过 / 不通过 / 重审）',
    description:
      '有效出发态 **2 COLLEGE_REVIEWING、5 SC_REJECTED**（R54 重审）：' +
      "`decision='approve'` → **4 SC_REVIEWING**（送双创；`5` 重审通过**覆盖** " +
      "collegeReview），`'reject'` → **3 COLLEGE_REJECTED**（退回申请人，" +
      '档案置 3 REJECTED）。`comment` **两个决定都必填**（R57，1-500 字符）。' +
      '天花板 **`dept`**（本部门**及下级**）：二级学院管理员只能审**本院**导师的' +
      '申请，越权 **403 / 10003**（assertDeptVisible，不是 404）。' +
      '状态机上没有的边一律 **409 / 31105**（含 `3 → 4`——退回后重交走 POST 新建，' +
      "不是把旧单推回审核流）。审核留痕落 SysOpLog（targetType='application'）。",
  })
  @ApiBody({
    type: CollegeReviewDto,
    description:
      '{ decision: approve | reject; comment: 1-500 字符（都必填） }',
  })
  @ApiOkResponse({
    type: MentorApplicationResponseDto,
    description: '审核完成（200）：新状态 + 审核记录已落',
  })
  @ApiNotFoundResponse({
    description: '申请不存在（404 / 31104）',
    schema: {
      example: errExample(
        ErrorCode.MENTOR_APPLICATION_NOT_FOUND,
        '入驻申请不存在',
      ),
    },
  })
  @ApiForbiddenResponse({
    description:
      '缺权限码（403 / 10003，消息点名缺的码）或审到外院（403 / 10003）',
    schema: {
      oneOf: errExamples(
        [
          ErrorCode.FORBIDDEN,
          '无权限访问：缺少 mentor-application:review-college',
        ],
        [ErrorCode.FORBIDDEN, '无权限'],
      ).map((example) => ({ example })),
    },
  })
  @ApiConflictResponse({
    description: '状态机上没有这条边（409 / 31105）',
    schema: {
      example: errExample(
        ErrorCode.MENTOR_APPLICATION_TRANSITION_INVALID,
        '当前状态不允许该操作',
      ),
    },
  })
  async collegeReview(
    @Body() dto: CollegeReviewDto,
    @Param() param: MentorApplicationParamDto,
    @CurrentUser() caller: RequestUser,
    @Req() req: Request,
  ): Promise<MentorApplicationResponseDto> {
    return this.reviewService.collegeReview(
      BigInt(param.id),
      dto,
      caller,
      toRequestMeta(req),
    );
  }

  @Post(':id/sc-review')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('mentor-application:review-sc')
  @DataScope('all')
  @ApiOperation({
    summary: '双创学院审核（通过 / 不通过）',
    description:
      "有效出发态 **4 SC_REVIEWING**：`decision='approve'` → **6 APPROVED**" +
      "（档案回写 2 APPROVED），`'reject'` → **5 SC_REJECTED**——**不写** " +
      'MentorProfile.status（裁定 R73：那是「退回二级学院重审」不是「退回申请人」）。' +
      '`comment` 两个决定都必填（R57）。天花板 **`all`**（双创审全校；挂 ' +
      "`'dept'` 会把 sc_admin 的 all 夹窄）。非法边（如 `3 → 6`）**409 / 31105**。" +
      '审核留痕落 SysOpLog。',
  })
  @ApiBody({
    type: ScReviewDto,
    description:
      '{ decision: approve | reject; comment: 1-500 字符（都必填） }',
  })
  @ApiOkResponse({
    type: MentorApplicationResponseDto,
    description: '审核完成（200）：新状态 + 审核记录已落',
  })
  @ApiNotFoundResponse({
    description: '申请不存在（404 / 31104）',
    schema: {
      example: errExample(
        ErrorCode.MENTOR_APPLICATION_NOT_FOUND,
        '入驻申请不存在',
      ),
    },
  })
  @ApiForbiddenResponse({
    description: '缺权限码（403 / 10003，消息点名缺的码）',
    schema: {
      example: errExample(
        ErrorCode.FORBIDDEN,
        '无权限访问：缺少 mentor-application:review-sc',
      ),
    },
  })
  @ApiConflictResponse({
    description: '状态机上没有这条边（409 / 31105）',
    schema: {
      example: errExample(
        ErrorCode.MENTOR_APPLICATION_TRANSITION_INVALID,
        '当前状态不允许该操作',
      ),
    },
  })
  async scReview(
    @Body() dto: ScReviewDto,
    @Param() param: MentorApplicationParamDto,
    @CurrentUser() caller: RequestUser,
    @Req() req: Request,
  ): Promise<MentorApplicationResponseDto> {
    return this.reviewService.scReview(
      BigInt(param.id),
      dto,
      caller,
      toRequestMeta(req),
    );
  }

  @Post(':id/withdraw')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('mentor-application:withdraw')
  @DataScope('self')
  @ApiOperation({
    summary: '申请人撤回自己的申请',
    description:
      '**空请求体**（出现任何字段 → 400 / 10001）。有效出发态 **1 / 2 / 3** → ' +
      '**7 WITHDRAWN**（档案回写 0 DRAFT，撤回=拿回来改）；**4 / 5 / 6 / 7 不可撤**' +
      '（计划：仅 1/2/3 可撤）→ **409 / 31105**。「只能撤自己的」靠身份链' +
      '（SysUser.username ↔ SyncPerson.login → personId 与 applicantId 比对），' +
      '撤别人的 **403 / 10003**。审核留痕落 SysOpLog（含被 31105 拒的）。',
  })
  @ApiBody({
    type: WithdrawApplicationDto,
    description: '**空请求体**（WithdrawApplicationDto 无字段）',
  })
  @ApiOkResponse({
    type: MentorApplicationResponseDto,
    description:
      '已撤回（200）：status=7 WITHDRAWN，MentorProfile.status → 0 DRAFT',
  })
  @ApiNotFoundResponse({
    description: '申请不存在（404 / 31104）',
    schema: {
      example: errExample(
        ErrorCode.MENTOR_APPLICATION_NOT_FOUND,
        '入驻申请不存在',
      ),
    },
  })
  @ApiForbiddenResponse({
    description: '撤别人的申请（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  @ApiConflictResponse({
    description: '4 / 5 / 6 / 7 调 withdraw（409 / 31105）',
    schema: {
      example: errExample(
        ErrorCode.MENTOR_APPLICATION_TRANSITION_INVALID,
        '当前状态不允许该操作',
      ),
    },
  })
  async withdraw(
    @Body() dto: WithdrawApplicationDto,
    @Param() param: MentorApplicationParamDto,
    @CurrentUser() caller: RequestUser,
    @Req() req: Request,
  ): Promise<MentorApplicationResponseDto> {
    // dto 只为触发空白名单校验（任何字段 → 400）；「撤自己的」靠身份链判定，
    // 服务端签名里没有它（eslint 的 after-used 规则不查前位未用参数）
    return this.reviewService.withdraw(
      BigInt(param.id),
      caller,
      toRequestMeta(req),
    );
  }
}

/**
 * 只取 path（不含 query）与来源标识（同 file.controller 的同名函数）。
 * `req.path` 长度受 sys_op_log.path 的 VARCHAR(200) 约束，超长截断——
 * 日志宁可丢尾巴，也不要因为一个超长 URL 把业务请求打成 500。
 */
function toRequestMeta(req: Request): ReviewRequestMeta {
  const userAgent = req.headers['user-agent'];
  return {
    method: req.method,
    path: req.path.slice(0, 200),
    ...(typeof req.ip === 'string' && req.ip !== '' ? { ip: req.ip } : {}),
    ...(typeof userAgent === 'string' ? { userAgent } : {}),
  };
}
