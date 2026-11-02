import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
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
import type { RequestUser } from '../../common/context/request-context';
import { ErrorCode } from '../../common/constants/error-code';
import { errExample, errExamples } from '../../common/dto/err-example';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AppointmentService } from './appointment.service';
import { AdjudicateAppointmentDto } from './dto/adjudicate-appointment.dto';
import { AppointmentParamDto } from './dto/appointment-param.dto';
import { CancelAppointmentDto } from './dto/cancel-appointment.dto';
import { ConfirmAppointmentDto } from './dto/confirm-appointment.dto';
import { ConfirmRecordDto } from './dto/confirm-record.dto';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { DisputeAppointmentDto } from './dto/dispute-appointment.dto';
import { RejectAppointmentDto } from './dto/reject-appointment.dto';
import { RescheduleAppointmentDto } from './dto/reschedule-appointment.dto';
import { AppointmentResponseDto } from './dto/appointment-response.dto';
import {
  AppointmentDetailDto,
  AppointmentListResponseDto,
  QueryAppointmentDto,
} from './dto/appointment-list.dto';
import { SubmitGuidanceRecordDto } from './dto/submit-guidance-record.dto';
import { GuidanceRecordResponseDto } from './dto/guidance-record-response.dto';
import {
  AppointmentMaterialItemParamDto,
  AppointmentMaterialListResponseDto,
  AppointmentMaterialParamDto,
  AppointmentMaterialResponseDto,
  AttachAppointmentMaterialDto,
  AttachRecordMaterialDto,
  DeleteAppointmentMaterialResponseDto,
} from './dto/appointment-material.dto';

/**
 * 预约（Task 23 / 24 / 25 / 26 / 27 / 28 / 29 / 30）——本模块**恰好 17 条路由**：
 *
 * - `POST /appointments`（学生发起，`appointment:create`）；
 * - `POST /appointments/:id/confirm`、`/reject`、`/reschedule`（导师处理，
 *   `appointment:handle`）；
 * - `POST /appointments/:id/cancel`（学生取消自己的预约，`appointment:create`）；
 * - `POST /appointments/:id/confirm-record`（学生确认指导记录，`appointment:create`）；
 * - `POST /appointments/:id/dispute`（学生对指导记录提异议，`appointment:create`）；
 * - `POST /appointments/:id/adjudicate`（二级学院管理员复核异议，
 *   `appointment:adjudicate`，`@DataScope('dept')`）；
 * - `POST /appointments/:id/record`（导师填报 / 重填指导记录，`appointment:handle`）；
 * - `GET /appointments/:id/record`（读取指导记录，`appointment:list`）；
 * - `POST /appointments/:id/materials`（学生挂预约材料，`appointment:create`）；
 * - `POST /appointments/:id/record/materials`（导师挂过程材料，`appointment:handle`）；
 * - `GET /appointments/:id/materials`（一次列出两类材料，`appointment:list`）；
 * - `DELETE /appointments/:id/materials/:materialId`（学生摘**预约材料**，
 *   `appointment:create`）；
 * - `DELETE /appointments/:id/record/materials/:materialId`（导师摘**过程材料**，
 *   `appointment:handle`）；
 * - `GET /appointments`（预约列表，`appointment:list`，`@DataScope('all')` + 服务内按
 *   有效数据范围收窄）；
 * - `GET /appointments/:id`（预约详情，`appointment:list`，`@DataScope('all')` +
 *   服务内可见性断言）。
 *
 * 前八条挂 `@DataScope('self')`：学生只能为自己发起 / 取消 / 确认 / 提异议，
 * 导师只能处理自己的预约。处理侧守卫顺序见 {@link AppointmentService.confirm} 等
 * （404 → 403 → 409），学生侧见 {@link AppointmentService.cancel}、
 * {@link AppointmentService.confirmRecord}、{@link AppointmentService.dispute}，
 * 填报侧见 {@link AppointmentService.submitRecord}。
 *
 * `adjudicate` 挂 `@DataScope('dept')` + 服务内 `assertDeptVisible(申请人部门)`，
 * 见 {@link AppointmentService.adjudicate}。
 *
 * 记录读取 / 材料列表 / 详情挂 `@DataScope('all')` + 服务内可见性断言（申请人本人 /
 * 导师本人 / 覆盖申请人部门的管理员），见 {@link AppointmentService.getRecord}、
 * {@link AppointmentService.listMaterials}、{@link AppointmentService.findOne}。
 *
 * 列表不夹窄到 `dept`（那会把 `all` 的双创学院管理员压成 `dept`）：天花板放 `all`，
 * 由 {@link AppointmentService.findPage} 按调用者的有效数据范围选视角，**不取并集**。
 *
 * 超时扫描（`0 PENDING` → `9 EXPIRED`）**不是路由**：它由
 * `AppointmentService.expireOverdue()` 暴露、`AppointmentExpiryScheduler` 定时调用。
 */
@ApiTags('预约')
@Controller('appointments')
export class AppointmentController {
  constructor(private readonly appointmentService: AppointmentService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('appointment:create')
  @DataScope('self')
  @ApiOperation({
    summary: '发起预约（学生）',
    description:
      '学生按导师开放时段发起一次预约，落 `status = 0 PENDING`。请求体 ' +
      '`{ mentorProfileId, type, slotId, requestedTime, topic, questions, mode }`：' +
      '`type` 1-5（R11），`mode` 1 线上 / 2 线下，`topic` 1-200 字，' +
      '`questions` 1-2000 字，`requestedTime` 为 ISO 8601 且**必须晚于当前时间**（R30）。' +
      '守卫先到先拒：调用者不是学生 → **403 / 10003**；导师档案不存在 / 未生效 / ' +
      '人员已离场 → **404 / 31102**；时段不存在 / 不属于该导师 / 已关闭 / 与期望时间不符 ' +
      '→ **409 / 31202**；同一时段已被未终态预约占用 → **409 / 32004**；' +
      '同一学生对同一导师已有未终态预约 → **409 / 32003**。',
  })
  @ApiBody({ type: CreateAppointmentDto })
  @ApiCreatedResponse({
    type: AppointmentResponseDto,
    description: '预约创建成功（201），`status = 0 PENDING`',
  })
  @ApiBadRequestResponse({
    description:
      'type 越界 / mode 越界 / requestedTime 非 ISO 8601 或不晚于当前时间 / ' +
      'topic 或 questions 长度越界 / 未知字段（400 / 10001）',
    schema: {
      example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败'),
    },
  })
  @ApiForbiddenResponse({
    description:
      '调用者不是学生（403 / 10003）或缺权限码 appointment:create（403 / 10003）',
    schema: {
      example: errExample(ErrorCode.FORBIDDEN, '只有学生可以发起预约'),
    },
  })
  @ApiNotFoundResponse({
    description: '导师档案不存在 / 未生效 / 已软删 / 人员已离场（404 / 31102）',
    schema: {
      example: errExample(
        ErrorCode.MENTOR_PROFILE_NOT_FOUND,
        '导师专业档案不存在',
      ),
    },
  })
  @ApiConflictResponse({
    description:
      '时段不存在 / 不属于该导师 / 已关闭 / 与期望时间不符（409 / 31202）；' +
      '时段已被占用（409 / 32004）；同学生同导师已有未终态预约（409 / 32003）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.MENTOR_SLOT_UNAVAILABLE, '可指导时段不可用'],
        [ErrorCode.APPOINTMENT_SLOT_CONFLICT, '该时段已被预约占用'],
        [
          ErrorCode.APPOINTMENT_TRANSITION_INVALID,
          '已有未完成的预约，不能重复发起',
        ],
      ).map((example) => ({ example })),
    },
  })
  async create(
    @Body() dto: CreateAppointmentDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AppointmentResponseDto> {
    return this.appointmentService.create(dto, caller);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('appointment:handle')
  @DataScope('self')
  @ApiOperation({
    summary: '确认预约（导师）',
    description:
      '导师确认一条 `0 PENDING` 的预约，推进到 `1 CONFIRMED`。请求体 ' +
      '`{ comment? }`：`comment` 可选 0-500 字，写进 `handleComment`；' +
      '不传或传 `null` 时 `handleComment` 落 `null`。守卫先到先拒：' +
      '预约不存在 / 已软删 → **404 / 32001**；不是该预约的导师本人 → **403 / 32002**；' +
      '`status != 0` → **409 / 32003**。',
  })
  @ApiBody({ type: ConfirmAppointmentDto })
  @ApiOkResponse({
    type: AppointmentResponseDto,
    description: '确认成功（200），`status = 1 CONFIRMED`',
  })
  @ApiBadRequestResponse({
    description: 'comment 长度越界 / 未知字段（400 / 10001）',
    schema: {
      example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败'),
    },
  })
  @ApiForbiddenResponse({
    description:
      '不是该预约的导师本人（403 / 32002）或缺权限码 appointment:handle（403 / 10003）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.APPOINTMENT_FORBIDDEN, '无权访问该预约'],
        [ErrorCode.FORBIDDEN, '无权限'],
      ).map((example) => ({ example })),
    },
  })
  @ApiNotFoundResponse({
    description: '预约不存在 / 已软删（404 / 32001）',
    schema: {
      example: errExample(ErrorCode.APPOINTMENT_NOT_FOUND, '预约不存在'),
    },
  })
  @ApiConflictResponse({
    description: '当前状态不是 0 PENDING（409 / 32003）',
    schema: {
      example: errExample(
        ErrorCode.APPOINTMENT_TRANSITION_INVALID,
        '当前状态不允许该操作',
      ),
    },
  })
  async confirm(
    @Param() params: AppointmentParamDto,
    @Body() dto: ConfirmAppointmentDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AppointmentResponseDto> {
    return this.appointmentService.confirm(BigInt(params.id), dto, caller);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('appointment:handle')
  @DataScope('self')
  @ApiOperation({
    summary: '拒绝预约（导师）',
    description:
      '导师拒绝一条 `0 PENDING` 的预约，推进到 `7 REJECTED`。请求体 ' +
      '`{ reason }`：`reason` **必填** 1-500 字，写进 `rejectReason`；缺省 / 空串 / ' +
      '超长 → **400 / 10001**，`data.fields` 点名 `reason`。守卫先到先拒：' +
      '预约不存在 / 已软删 → **404 / 32001**；不是该预约的导师本人 → **403 / 32002**；' +
      '`status != 0` → **409 / 32003**。',
  })
  @ApiBody({ type: RejectAppointmentDto })
  @ApiOkResponse({
    type: AppointmentResponseDto,
    description: '拒绝成功（200），`status = 7 REJECTED`',
  })
  @ApiBadRequestResponse({
    description:
      'reason 缺失 / 为空 / 超过 500 字 / 未知字段（400 / 10001，点名 reason）',
    schema: {
      example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败'),
    },
  })
  @ApiForbiddenResponse({
    description:
      '不是该预约的导师本人（403 / 32002）或缺权限码 appointment:handle（403 / 10003）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.APPOINTMENT_FORBIDDEN, '无权访问该预约'],
        [ErrorCode.FORBIDDEN, '无权限'],
      ).map((example) => ({ example })),
    },
  })
  @ApiNotFoundResponse({
    description: '预约不存在 / 已软删（404 / 32001）',
    schema: {
      example: errExample(ErrorCode.APPOINTMENT_NOT_FOUND, '预约不存在'),
    },
  })
  @ApiConflictResponse({
    description: '当前状态不是 0 PENDING（409 / 32003）',
    schema: {
      example: errExample(
        ErrorCode.APPOINTMENT_TRANSITION_INVALID,
        '当前状态不允许该操作',
      ),
    },
  })
  async reject(
    @Param() params: AppointmentParamDto,
    @Body() dto: RejectAppointmentDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AppointmentResponseDto> {
    return this.appointmentService.reject(BigInt(params.id), dto, caller);
  }

  @Post(':id/reschedule')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('appointment:handle')
  @DataScope('self')
  @ApiOperation({
    summary: '调整预约时间（导师）',
    description:
      '导师对一条 `0 PENDING` 的预约提出新时间，**状态仍是 `0 PENDING`**。请求体 ' +
      '`{ proposedTime, comment? }`：`proposedTime` 为 **ISO 8601 字符串**' +
      '（数字时间戳不收）且**必须晚于当前时间**（否则 400 / 10001，点名 ' +
      '`proposedTime`）；**不校验是否落在导师开放时段内**（R33）。' +
      '落库只更新 `proposedTime` 与 `handleComment`，**`requestedTime` 一字不动**（R13）。' +
      '守卫先到先拒：预约不存在 / 已软删 → **404 / 32001**；不是该预约的导师本人 → ' +
      '**403 / 32002**；`status != 0` → **409 / 32003**。',
  })
  @ApiBody({ type: RescheduleAppointmentDto })
  @ApiOkResponse({
    type: AppointmentResponseDto,
    description: '调整成功（200），`status` 仍为 `0 PENDING`',
  })
  @ApiBadRequestResponse({
    description:
      'proposedTime 非 ISO 8601 / 不晚于当前时间 / comment 长度越界 / 未知字段（400 / 10001）',
    schema: {
      example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败'),
    },
  })
  @ApiForbiddenResponse({
    description:
      '不是该预约的导师本人（403 / 32002）或缺权限码 appointment:handle（403 / 10003）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.APPOINTMENT_FORBIDDEN, '无权访问该预约'],
        [ErrorCode.FORBIDDEN, '无权限'],
      ).map((example) => ({ example })),
    },
  })
  @ApiNotFoundResponse({
    description: '预约不存在 / 已软删（404 / 32001）',
    schema: {
      example: errExample(ErrorCode.APPOINTMENT_NOT_FOUND, '预约不存在'),
    },
  })
  @ApiConflictResponse({
    description: '当前状态不是 0 PENDING（409 / 32003）',
    schema: {
      example: errExample(
        ErrorCode.APPOINTMENT_TRANSITION_INVALID,
        '当前状态不允许该操作',
      ),
    },
  })
  async reschedule(
    @Param() params: AppointmentParamDto,
    @Body() dto: RescheduleAppointmentDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AppointmentResponseDto> {
    return this.appointmentService.reschedule(BigInt(params.id), dto, caller);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('appointment:create')
  @DataScope('self')
  @ApiOperation({
    summary: '取消预约（学生）',
    description:
      '申请人本人取消自己的预约：出发态 **`0 PENDING` / `1 CONFIRMED`** → ' +
      '**`8 CANCELLED`**（R18）；其余状态（`2`–`7`、`9`）→ **409 / 32003**。' +
      '**空请求体**（出现任何字段 → 400 / 10001）。守卫先到先拒：' +
      '预约不存在 / 已软删 → **404 / 32001**；不是申请人本人（别的学生 / 导师 / ' +
      '管理员）→ **403 / 32002**；状态不可取消 → **409 / 32003**。',
  })
  @ApiBody({
    type: CancelAppointmentDto,
    description: '**空请求体**（CancelAppointmentDto 无字段）',
  })
  @ApiOkResponse({
    type: AppointmentResponseDto,
    description: '取消成功（200），`status = 8 CANCELLED`',
  })
  @ApiBadRequestResponse({
    description: '请求体出现任何字段 / 路径 id 不是数字（400 / 10001）',
    schema: {
      example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败'),
    },
  })
  @ApiForbiddenResponse({
    description:
      '不是申请人本人（403 / 32002）或缺权限码 appointment:create（403 / 10003）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.APPOINTMENT_FORBIDDEN, '无权访问该预约'],
        [ErrorCode.FORBIDDEN, '无权限'],
      ).map((example) => ({ example })),
    },
  })
  @ApiNotFoundResponse({
    description: '预约不存在 / 已软删（404 / 32001）',
    schema: {
      example: errExample(ErrorCode.APPOINTMENT_NOT_FOUND, '预约不存在'),
    },
  })
  @ApiConflictResponse({
    description: '当前状态不是 0 PENDING / 1 CONFIRMED（409 / 32003）',
    schema: {
      example: errExample(
        ErrorCode.APPOINTMENT_TRANSITION_INVALID,
        '当前状态不允许该操作',
      ),
    },
  })
  async cancel(
    @Body() dto: CancelAppointmentDto,
    @Param() params: AppointmentParamDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AppointmentResponseDto> {
    // dto 只为触发空白名单校验（任何字段 → 400）；「取消自己的」靠身份链判定，
    // 服务端签名里没有它（eslint 的 after-used 规则不查前位未用参数）
    return this.appointmentService.cancel(BigInt(params.id), caller);
  }

  @Post(':id/confirm-record')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('appointment:create')
  @DataScope('self')
  @ApiOperation({
    summary: '确认指导记录（学生）',
    description:
      '申请人本人核对导师填报的指导记录后确认，**`3 RECORD_SUBMITTED` → ' +
      '`4 STUDENT_CONFIRMED`**。**不直接到 `6 COMPLETED`**——P3 的学生评价接在 ' +
      '`4` 之后。**空请求体**（出现任何字段 → 400 / 10001）。守卫先到先拒：' +
      '预约不存在 / 已软删 → **404 / 32001**；不是申请人本人（别的学生 / 导师 / ' +
      '管理员）→ **403 / 32002**；`status != 3` → **409 / 32003**。',
  })
  @ApiBody({
    type: ConfirmRecordDto,
    description: '**空请求体**（ConfirmRecordDto 无字段）',
  })
  @ApiOkResponse({
    type: AppointmentResponseDto,
    description: '确认成功（200），`status = 4 STUDENT_CONFIRMED`',
  })
  @ApiBadRequestResponse({
    description: '请求体出现任何字段 / 路径 id 不是数字（400 / 10001）',
    schema: {
      example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败'),
    },
  })
  @ApiForbiddenResponse({
    description:
      '不是申请人本人（403 / 32002）或缺权限码 appointment:create（403 / 10003）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.APPOINTMENT_FORBIDDEN, '无权访问该预约'],
        [ErrorCode.FORBIDDEN, '无权限'],
      ).map((example) => ({ example })),
    },
  })
  @ApiNotFoundResponse({
    description: '预约不存在 / 已软删（404 / 32001）',
    schema: {
      example: errExample(ErrorCode.APPOINTMENT_NOT_FOUND, '预约不存在'),
    },
  })
  @ApiConflictResponse({
    description: '当前状态不是 3 RECORD_SUBMITTED（409 / 32003）',
    schema: {
      example: errExample(
        ErrorCode.APPOINTMENT_TRANSITION_INVALID,
        '当前状态不允许该操作',
      ),
    },
  })
  async confirmRecord(
    @Body() dto: ConfirmRecordDto,
    @Param() params: AppointmentParamDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AppointmentResponseDto> {
    // dto 只为触发空白名单校验（任何字段 → 400）；「确认自己的」靠身份链判定
    return this.appointmentService.confirmRecord(BigInt(params.id), caller);
  }

  @Post(':id/dispute')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('appointment:create')
  @DataScope('self')
  @ApiOperation({
    summary: '对指导记录提异议（学生）',
    description:
      '申请人本人对导师填报的指导记录有异议时提交反馈申请复核，**`3 ' +
      'RECORD_SUBMITTED` → `5 DISPUTED`**。请求体 `{ reason }`：`reason` **必填** ' +
      '1-500 字，写进 `disputeReason`；缺省 / 空串 / 超长 → **400 / 10001**，' +
      '`data.fields` 点名 `reason`。守卫先到先拒：预约不存在 / 已软删 → ' +
      '**404 / 32001**；不是申请人本人（别的学生 / 导师 / 管理员）→ **403 / 32002**；' +
      '`status != 3` → **409 / 32003**。',
  })
  @ApiBody({ type: DisputeAppointmentDto })
  @ApiOkResponse({
    type: AppointmentResponseDto,
    description: '提异议成功（200），`status = 5 DISPUTED`',
  })
  @ApiBadRequestResponse({
    description:
      'reason 缺失 / 为空 / 超过 500 字 / 未知字段（400 / 10001，点名 reason）',
    schema: {
      example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败'),
    },
  })
  @ApiForbiddenResponse({
    description:
      '不是申请人本人（403 / 32002）或缺权限码 appointment:create（403 / 10003）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.APPOINTMENT_FORBIDDEN, '无权访问该预约'],
        [ErrorCode.FORBIDDEN, '无权限'],
      ).map((example) => ({ example })),
    },
  })
  @ApiNotFoundResponse({
    description: '预约不存在 / 已软删（404 / 32001）',
    schema: {
      example: errExample(ErrorCode.APPOINTMENT_NOT_FOUND, '预约不存在'),
    },
  })
  @ApiConflictResponse({
    description: '当前状态不是 3 RECORD_SUBMITTED（409 / 32003）',
    schema: {
      example: errExample(
        ErrorCode.APPOINTMENT_TRANSITION_INVALID,
        '当前状态不允许该操作',
      ),
    },
  })
  async dispute(
    @Param() params: AppointmentParamDto,
    @Body() dto: DisputeAppointmentDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AppointmentResponseDto> {
    return this.appointmentService.dispute(BigInt(params.id), dto, caller);
  }

  @Post(':id/adjudicate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('appointment:adjudicate')
  @DataScope('dept')
  @ApiOperation({
    summary: '异议复核（二级学院管理员）',
    description:
      '二级学院管理员复核学生对指导记录的异议（需求 §4.3），请求体 ' +
      "`{ decision: 'uphold' | 'return', comment }`：`comment` **两个决定都必填** " +
      '1-500 字，写进 `adjudicateComment`。`uphold` → **`5 DISPUTED` → ' +
      '`6 COMPLETED`**（支持学生，异议成立，直接完成，`disputeReason` 清空）；' +
      '`return` → **`5 DISPUTED` → `3 RECORD_SUBMITTED`**（退回导师重填，' +
      '**`disputeReason` 保留**，R36）。守卫先到先拒：预约不存在 / 已软删 → ' +
      '**404 / 32001**；数据范围不覆盖**申请人所在学院** → **403 / 10003**' +
      '（`assertDeptVisible`，不是 404，也不是 32002）；`status != 5` → ' +
      '**409 / 32003**。',
  })
  @ApiBody({ type: AdjudicateAppointmentDto })
  @ApiOkResponse({
    type: AppointmentResponseDto,
    description:
      '复核成功（200）：`uphold` → `status = 6 COMPLETED`；' +
      '`return` → `status = 3 RECORD_SUBMITTED`',
  })
  @ApiBadRequestResponse({
    description:
      'decision 不是 uphold / return、comment 缺失 / 为空 / 超过 500 字 / ' +
      '未知字段（400 / 10001，点名 decision 或 comment）',
    schema: {
      example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败'),
    },
  })
  @ApiForbiddenResponse({
    description:
      '申请人所在学院不在数据范围内（403 / 10003）或缺权限码 appointment:adjudicate（403 / 10003）',
    schema: {
      example: errExample(ErrorCode.FORBIDDEN, '无权限'),
    },
  })
  @ApiNotFoundResponse({
    description: '预约不存在 / 已软删（404 / 32001）',
    schema: {
      example: errExample(ErrorCode.APPOINTMENT_NOT_FOUND, '预约不存在'),
    },
  })
  @ApiConflictResponse({
    description: '当前状态不是 5 DISPUTED（409 / 32003）',
    schema: {
      example: errExample(
        ErrorCode.APPOINTMENT_TRANSITION_INVALID,
        '当前状态不允许该操作',
      ),
    },
  })
  async adjudicate(
    @Param() params: AppointmentParamDto,
    @Body() dto: AdjudicateAppointmentDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AppointmentResponseDto> {
    return this.appointmentService.adjudicate(BigInt(params.id), dto, caller);
  }

  @Post(':id/record')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('appointment:handle')
  @DataScope('self')
  @ApiOperation({
    summary: '填报 / 重填指导记录（导师）',
    description:
      '导师对自己 `1 CONFIRMED` 的预约填报指导记录，预约**一步推进到** ' +
      '`3 RECORD_SUBMITTED`（跳过 `2 IN_PROGRESS` 的可观测性，R19）。' +
      '**R37 重填**：预约已是 `3 RECORD_SUBMITTED` 时（管理员退回后）也放行——' +
      '**更新**该预约已有的那一条记录、状态**保持 3**，`submittedAt` 刷新。' +
      '**重填也返回 201**（与首次填报同码，原因见 R37 / 报告 §8-A）：' +
      '`@HttpCode` 是静态元数据，动态状态码只能手写响应、绕开统一响应外壳；' +
      '建 / 改的区别由库内是否已有记录与响应体表达。' +
      '请求体 `{ actualTime, mode, coreContent, followUp }`（R26 / §3.4）：' +
      '`actualTime` 为 **ISO 8601 字符串**且**不得晚于当前时间**（R35）；' +
      '`mode` 1 线上 / 2 线下；`coreContent` 1-5000 字；`followUp` 1-2000 字。' +
      '「学生信息」不收——由 `appointment.studentPersonId` 联查返回（R27）。' +
      '守卫先到先拒：预约不存在 / 已软删 → **404 / 32001**；不是该预约的导师本人 → ' +
      '**403 / 32002**；出发态不是 `1` / `3` → **409 / 32003**。',
  })
  @ApiBody({ type: SubmitGuidanceRecordDto })
  @ApiCreatedResponse({
    type: GuidanceRecordResponseDto,
    description:
      '填报成功（201）：`1 → 3` 建记录；`3` 态重填同样返回 201，记录被更新、状态仍为 `3`',
  })
  @ApiBadRequestResponse({
    description:
      'actualTime 非 ISO 8601 或晚于当前时间 / mode 越界 / coreContent 或 ' +
      'followUp 长度越界 / 未知字段（400 / 10001）',
    schema: {
      example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败'),
    },
  })
  @ApiForbiddenResponse({
    description:
      '不是该预约的导师本人（403 / 32002）或缺权限码 appointment:handle（403 / 10003）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.APPOINTMENT_FORBIDDEN, '无权访问该预约'],
        [ErrorCode.FORBIDDEN, '无权限'],
      ).map((example) => ({ example })),
    },
  })
  @ApiNotFoundResponse({
    description: '预约不存在 / 已软删（404 / 32001）',
    schema: {
      example: errExample(ErrorCode.APPOINTMENT_NOT_FOUND, '预约不存在'),
    },
  })
  @ApiConflictResponse({
    description:
      '出发态不是 1 CONFIRMED / 3 RECORD_SUBMITTED（409 / 32003）；' +
      '并发双发首次填报时，输掉的一方也是 409 / 32003',
    schema: {
      example: errExample(
        ErrorCode.APPOINTMENT_TRANSITION_INVALID,
        '当前状态不允许该操作',
      ),
    },
  })
  async submitRecord(
    @Param() params: AppointmentParamDto,
    @Body() dto: SubmitGuidanceRecordDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<GuidanceRecordResponseDto> {
    return this.appointmentService.submitRecord(BigInt(params.id), dto, caller);
  }

  @Get(':id/record')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('appointment:list')
  @DataScope('all')
  @ApiOperation({
    summary: '读取指导记录',
    description:
      '读取一条预约的指导记录。可见性三选一：申请人本人 / 该预约的导师本人 / ' +
      '数据范围覆盖**申请人部门**的管理员；其余 → **403 / 32002**（不是 404）。' +
      '记录尚未填报 / 已软删 → **404 / 33001**。响应含 `student`（`realName` / ' +
      '`login` / `major` / `className` / `mobile`，由 `appointment.studentPersonId` ' +
      '联查，R27）。',
  })
  @ApiOkResponse({
    type: GuidanceRecordResponseDto,
    description: '读取成功（200）',
  })
  @ApiForbiddenResponse({
    description:
      '不在可见范围内（403 / 32002）或缺权限码 appointment:list（403 / 10003）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.APPOINTMENT_FORBIDDEN, '无权访问该预约'],
        [ErrorCode.FORBIDDEN, '无权限'],
      ).map((example) => ({ example })),
    },
  })
  @ApiNotFoundResponse({
    description: '指导记录不存在 / 已软删（404 / 33001）',
    schema: {
      example: errExample(
        ErrorCode.GUIDANCE_RECORD_NOT_FOUND,
        '指导记录不存在',
      ),
    },
  })
  async getRecord(
    @Param() params: AppointmentParamDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<GuidanceRecordResponseDto> {
    return this.appointmentService.getRecord(BigInt(params.id), caller);
  }

  @Post(':id/materials')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('appointment:create')
  @DataScope('self')
  @ApiOperation({
    summary: '学生挂预约材料',
    description:
      '学生把 `POST /files` 上传的文件挂到**自己的**预约上。请求体 ' +
      '`{ fileId, kind }`：`fileId` 是上传返回的 id；`kind` **必填**——' +
      '1 项目计划书 / 2 竞赛备赛资料 / 3 其他，落库并在响应回显。上传时 ' +
      '`ownerType` / `ownerId` 必须成对给出 ' +
      "`'Appointment'` + 本预约 ID（**大小写敏感**，不是 `'MentorApplication'`）。" +
      '守卫：预约不存在 → **404 / 32001**；不是申请人本人 → **403 / 32002**；' +
      '终态 `6/7/8/9` → **409 / 32003**；文件不存在 / 无归属 / 归属不符 → ' +
      '**404 / 28101**（同码同文案）；同一 fileId 重复挂 → **409 / 32006**' +
      '（并发双发由 DB 唯一键兜底，同码）。',
  })
  @ApiBody({ type: AttachAppointmentMaterialDto })
  @ApiCreatedResponse({
    type: AppointmentMaterialResponseDto,
    description: '挂接成功（201），`source = appointment`',
  })
  @ApiNotFoundResponse({
    description: '预约不存在（404 / 32001）或文件不存在（404 / 28101）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.APPOINTMENT_NOT_FOUND, '预约不存在'],
        [ErrorCode.FILE_NOT_FOUND, '文件不存在'],
      ).map((example) => ({ example })),
    },
  })
  @ApiForbiddenResponse({
    description:
      '不是申请人本人 / 缺权限码 appointment:create（403 / 32002 或 10003）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.APPOINTMENT_FORBIDDEN, '无权访问该预约'],
        [ErrorCode.FORBIDDEN, '无权限'],
      ).map((example) => ({ example })),
    },
  })
  @ApiConflictResponse({
    description: '终态不许挂（409 / 32003）或重复挂（409 / 32006）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.APPOINTMENT_TRANSITION_INVALID, '当前状态不允许该操作'],
        [ErrorCode.APPOINTMENT_MATERIAL_DUPLICATE, '该材料已挂接'],
      ).map((example) => ({ example })),
    },
  })
  async attachMaterial(
    @Param() params: AppointmentMaterialParamDto,
    @Body() dto: AttachAppointmentMaterialDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AppointmentMaterialResponseDto> {
    return this.appointmentService.attachAppointmentMaterial(
      BigInt(params.id),
      dto,
      caller,
    );
  }

  @Post(':id/record/materials')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('appointment:handle')
  @DataScope('self')
  @ApiOperation({
    summary: '导师挂过程材料',
    description:
      '导师把 `POST /files` 上传的文件挂到**自己的**预约的指导记录上（课件 / ' +
      '交流笔记 / 项目修改意见等）。请求体 `{ fileId }`；过程材料**不分类** ' +
      '（`GuidanceMaterial` 无 kind 列，响应 `kind` 恒为 null），因此**不接受** ' +
      '`kind` 字段。文件归属锚点仍是这条预约：' +
      "`ownerType='Appointment'` + `ownerId=本预约 ID`。守卫：预约不存在 → " +
      '**404 / 32001**；不是该预约的导师本人 → **403 / 32002**；记录尚未存在 ' +
      '（`status ∉ {3,4,5,6}`，含 `0` / `1`）→ **409 / 32003**；文件归属不符 → ' +
      '**404 / 28101**；同一 fileId 重复挂 → **409 / 32006**' +
      '（并发双发由 DB 唯一键兜底，同码）。',
  })
  @ApiBody({ type: AttachRecordMaterialDto })
  @ApiCreatedResponse({
    type: AppointmentMaterialResponseDto,
    description: '挂接成功（201），`source = record`',
  })
  @ApiNotFoundResponse({
    description: '预约不存在（404 / 32001）或文件不存在（404 / 28101）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.APPOINTMENT_NOT_FOUND, '预约不存在'],
        [ErrorCode.FILE_NOT_FOUND, '文件不存在'],
      ).map((example) => ({ example })),
    },
  })
  @ApiForbiddenResponse({
    description:
      '不是该预约的导师本人 / 缺权限码 appointment:handle（403 / 32002 或 10003）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.APPOINTMENT_FORBIDDEN, '无权访问该预约'],
        [ErrorCode.FORBIDDEN, '无权限'],
      ).map((example) => ({ example })),
    },
  })
  @ApiConflictResponse({
    description: '记录尚未存在（409 / 32003）或重复挂（409 / 32006）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.APPOINTMENT_TRANSITION_INVALID, '当前状态不允许该操作'],
        [ErrorCode.APPOINTMENT_MATERIAL_DUPLICATE, '该材料已挂接'],
      ).map((example) => ({ example })),
    },
  })
  async attachRecordMaterial(
    @Param() params: AppointmentMaterialParamDto,
    @Body() dto: AttachRecordMaterialDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AppointmentMaterialResponseDto> {
    return this.appointmentService.attachRecordMaterial(
      BigInt(params.id),
      dto,
      caller,
    );
  }

  @Get(':id/materials')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('appointment:list')
  @DataScope('all')
  @ApiOperation({
    summary: '列出预约的全部材料（两类）',
    description:
      '**一次返回两类材料**，每条带 `source` 字段区分：`appointment`（预约材料，' +
      '学生传）/ `record`（过程材料，导师传）。可见性同 `GET /record`：申请人本人 / ' +
      '该预约的导师本人 / 数据范围覆盖**申请人部门**的管理员；其余 → **403 / 32002**。' +
      '预约不存在 / 已软删 → **404 / 32001**。**不分页**（材料是子资源、条数有界），' +
      '`page` 恒 1、`pageSize` = total。',
  })
  @ApiOkResponse({
    type: AppointmentMaterialListResponseDto,
    description: '该预约的全部材料（未删行）',
  })
  @ApiNotFoundResponse({
    description: '预约不存在 / 已软删（404 / 32001）',
    schema: {
      example: errExample(ErrorCode.APPOINTMENT_NOT_FOUND, '预约不存在'),
    },
  })
  @ApiForbiddenResponse({
    description:
      '不在可见范围内（403 / 32002）或缺权限码 appointment:list（403 / 10003）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.APPOINTMENT_FORBIDDEN, '无权访问该预约'],
        [ErrorCode.FORBIDDEN, '无权限'],
      ).map((example) => ({ example })),
    },
  })
  async listMaterials(
    @Param() params: AppointmentMaterialParamDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AppointmentMaterialListResponseDto> {
    return this.appointmentService.listMaterials(BigInt(params.id), caller);
  }

  @Delete(':id/materials/:materialId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('appointment:create')
  @DataScope('self')
  @ApiOperation({
    summary: '学生摘除预约材料（软删）',
    description:
      '摘掉**预约材料**（`appointment_material`）。权限码 `appointment:create` ' +
      '在控制器声明；服务再校验**归属**：调用者必须是该预约的申请人本人。' +
      '`materialId` 不存在 / 已软删 / 属于别的预约 → **404 / 32005**；不是本人 → ' +
      '**403 / 32002**。摘除是**软删**：材料行打 `deletedAt`，`SysFile` **不动**；' +
      '摘后同一 fileId 允许再挂。',
  })
  @ApiOkResponse({
    type: DeleteAppointmentMaterialResponseDto,
    description: '摘除成功（200），`source = appointment`',
  })
  @ApiNotFoundResponse({
    description:
      '预约不存在（404 / 32001）或材料不存在 / 已软删（404 / 32005）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.APPOINTMENT_NOT_FOUND, '预约不存在'],
        [ErrorCode.APPOINTMENT_MATERIAL_NOT_FOUND, '预约材料不存在'],
      ).map((example) => ({ example })),
    },
  })
  @ApiForbiddenResponse({
    description:
      '缺权限码 appointment:create（403 / 10003）或不是申请人本人（403 / 32002）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.FORBIDDEN, '无权限访问：缺少 appointment:create'],
        [ErrorCode.APPOINTMENT_FORBIDDEN, '无权访问该预约'],
      ).map((example) => ({ example })),
    },
  })
  async removeAppointmentMaterial(
    @Param() params: AppointmentMaterialItemParamDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<DeleteAppointmentMaterialResponseDto> {
    return this.appointmentService.removeAppointmentMaterial(
      BigInt(params.id),
      BigInt(params.materialId),
      caller,
    );
  }

  @Delete(':id/record/materials/:materialId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('appointment:handle')
  @DataScope('self')
  @ApiOperation({
    summary: '导师摘除过程材料（软删）',
    description:
      '摘掉**过程材料**（`guidance_material`）。权限码 `appointment:handle` 在' +
      '控制器声明；服务再校验**归属**：调用者必须是该预约的导师本人。' +
      '`materialId` 不存在 / 已软删 / 属于别的记录 → **404 / 33002**；不是本人 → ' +
      '**403 / 32002**。摘除是**软删**：材料行打 `deletedAt`，`SysFile` **不动**；' +
      '摘后同一 fileId 允许再挂。',
  })
  @ApiOkResponse({
    type: DeleteAppointmentMaterialResponseDto,
    description: '摘除成功（200），`source = record`',
  })
  @ApiNotFoundResponse({
    description:
      '预约不存在（404 / 32001）或材料不存在 / 已软删（404 / 33002）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.APPOINTMENT_NOT_FOUND, '预约不存在'],
        [ErrorCode.GUIDANCE_MATERIAL_NOT_FOUND, '过程材料不存在'],
      ).map((example) => ({ example })),
    },
  })
  @ApiForbiddenResponse({
    description:
      '缺权限码 appointment:handle（403 / 10003）或不是该预约的导师本人（403 / 32002）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.FORBIDDEN, '无权限访问：缺少 appointment:handle'],
        [ErrorCode.APPOINTMENT_FORBIDDEN, '无权访问该预约'],
      ).map((example) => ({ example })),
    },
  })
  async removeRecordMaterial(
    @Param() params: AppointmentMaterialItemParamDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<DeleteAppointmentMaterialResponseDto> {
    return this.appointmentService.removeRecordMaterial(
      BigInt(params.id),
      BigInt(params.materialId),
      caller,
    );
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('appointment:list')
  @DataScope('all')
  @ApiOperation({
    summary: '预约列表（三种视角）',
    description:
      '**一个接口三种视角**，按调用者的**有效数据范围**选一种，**不取并集**：' +
      '学生（`self` 且无导师档案）只看自己发起的（`studentPersonId = 本人`）；' +
      '导师（`self` 且有导师档案）只看约自己的（`mentorProfileId ∈ 我名下的档案`）；' +
      '管理员按**申请人部门**收窄（`dept` / `deptAndChildren` → 申请人所在组织投影的' +
      '部门在集合内，R14），`all` 不加约束。解析不出人（同步未及）→ 空集，不是全部。' +
      '查询参数 `status?`（0-9）/ `type?`（1-5）/ `page`（默认 1，≥1）/ ' +
      '`pageSize`（默认 20，1-100）；越界 → **400 / 10001**。' +
      '排序 `createdAt DESC, id DESC`（同一毫秒也稳定）；`total` 是**过滤后的总数**，' +
      '不是当前页条数。列表项含 `student` / `mentor` 两项联查信息（导师处理预约时' +
      '必须看见学生姓名，§4.3）。',
  })
  @ApiOkResponse({
    type: AppointmentListResponseDto,
    description: '分页列表（RES-06：`{ list, total, page, pageSize }`）',
  })
  @ApiBadRequestResponse({
    description:
      'status / type 越界、page < 1、pageSize 不在 1-100、未知查询参数（400 / 10001）',
    schema: {
      example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败'),
    },
  })
  @ApiForbiddenResponse({
    description: '缺权限码 appointment:list（403 / 10003）',
    schema: {
      example: errExample(ErrorCode.FORBIDDEN, '无权限'),
    },
  })
  async list(
    @Query() query: QueryAppointmentDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AppointmentListResponseDto> {
    return this.appointmentService.findPage(query, caller);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('appointment:list')
  @DataScope('all')
  @ApiOperation({
    summary: '预约详情',
    description:
      '读取一条预约的完整信息：预约本身的全字段 + `student`（`personId` / `login` / ' +
      '`realName` / `orgUnitName` / `major` / `className` / `mobile`，由 ' +
      '`appointment.studentPersonId` 联查）+ `mentor`（`mentorProfileId` / `realName` / ' +
      '`orgUnitName`）。可见性三选一：申请人本人 / 该预约的导师本人 / 数据范围覆盖' +
      '**申请人部门**的管理员；其余 → **403 / 32002**（不是 404）。' +
      '预约不存在 / 已软删 → **404 / 32001**。',
  })
  @ApiOkResponse({
    type: AppointmentDetailDto,
    description: '读取成功（200）',
  })
  @ApiNotFoundResponse({
    description: '预约不存在 / 已软删（404 / 32001）',
    schema: {
      example: errExample(ErrorCode.APPOINTMENT_NOT_FOUND, '预约不存在'),
    },
  })
  @ApiForbiddenResponse({
    description:
      '不在可见范围内（403 / 32002）或缺权限码 appointment:list（403 / 10003）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.APPOINTMENT_FORBIDDEN, '无权访问该预约'],
        [ErrorCode.FORBIDDEN, '无权限'],
      ).map((example) => ({ example })),
    },
  })
  async detail(
    @Param() params: AppointmentParamDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AppointmentDetailDto> {
    return this.appointmentService.findOne(BigInt(params.id), caller);
  }
}
