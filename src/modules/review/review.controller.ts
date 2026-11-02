import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
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
import { errExample, errExamples } from '../../common/dto/err-example';
import type { RequestUser } from '../../common/context/request-context';
import { AppointmentParamDto } from '../appointment/dto/appointment-param.dto';
import { CreateReviewDto } from './dto/create-review.dto';
import { ReviewResponseDto } from './dto/review-response.dto';
import { ReviewService } from './review.service';

/**
 * 评价（P3 Task 34）——挂在预约路径下的**两条**路由：
 *
 * - `POST /appointments/:id/review`（学生评价，`review:create`，`@DataScope('self')`）；
 * - `GET /appointments/:id/review`（读取，`review:list`，`@DataScope('all')` +
 *   服务内可见性断言）。
 *
 * 挂在 `/appointments` 下是因为**评价的主体就是一条预约**：一条预约一条评价
 * （唯一键钉着），脱离预约谈评价没有意义。导师维度的汇总在
 * {@link MentorReviewController}。
 */
@ApiTags('评价')
@Controller('appointments')
export class ReviewController {
  constructor(private readonly reviewService: ReviewService) {}

  @Post(':id/review')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('review:create')
  @DataScope('self')
  @ApiOperation({
    summary: '提交学生评价',
    description:
      '申请人对一条 `4 STUDENT_CONFIRMED` 的预约提交评价。请求体 ' +
      '`{ attitude, expertise, effect, comment? }`：三个维度各 1-5 分，' +
      '`comment` 可空（≤1000 字）。**`overallScore` 不在请求体里**——由服务端按 ' +
      '`round((attitude + expertise + effect) / 3, 2)` 计算（R41）；多传 → 400 / 10001。' +
      '成功时**同一事务**内把预约从 `4` 推进到 `6 COMPLETED`。' +
      '守卫先到先拒：预约不存在 / 已软删 → **404 / 32001**；不是申请人本人 → ' +
      '**403 / 32002**；`status ≠ 4` → **409 / 34003**；已有评价 → **409 / 34002**。' +
      '响应**匿名**：不含任何学生身份字段（R44）。',
  })
  @ApiBody({ type: CreateReviewDto })
  @ApiCreatedResponse({
    type: ReviewResponseDto,
    description: '评价成功（201），预约同时推进到 `6 COMPLETED`',
  })
  @ApiBadRequestResponse({
    description:
      'attitude / expertise / effect 越界（不在 1-5）、comment 超过 1000 字、' +
      '请求体里出现 overallScore 或未知字段（400 / 10001）',
    schema: {
      example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败'),
    },
  })
  @ApiForbiddenResponse({
    description:
      '不是该预约的申请人本人（403 / 32002）或缺权限码 review:create（403 / 10003）',
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
      '预约状态不是 4 STUDENT_CONFIRMED（409 / 34003）或该预约已评价过（409 / 34002）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.REVIEW_NOT_ALLOWED, '当前状态不允许评价'],
        [ErrorCode.REVIEW_ALREADY_EXISTS, '该预约已评价过'],
      ).map((example) => ({ example })),
    },
  })
  async create(
    @Param() params: AppointmentParamDto,
    @Body() dto: CreateReviewDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<ReviewResponseDto> {
    return this.reviewService.create(BigInt(params.id), dto, caller);
  }

  @Get(':id/review')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('review:list')
  @DataScope('all')
  @ApiOperation({
    summary: '读取一条预约的评价',
    description:
      '可见性三选一：申请人本人 / 该预约的导师本人 / 数据范围覆盖**申请人部门**的' +
      '管理员；其余 → **403 / 32002**（不是 404）。预约不存在 / 已软删 → ' +
      '**404 / 32001**；该预约还没有评价 → **404 / 34001**。响应**匿名**（R44）。',
  })
  @ApiOkResponse({ type: ReviewResponseDto, description: '读取成功（200）' })
  @ApiForbiddenResponse({
    description:
      '不在可见范围内（403 / 32002）或缺权限码 review:list（403 / 10003）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.APPOINTMENT_FORBIDDEN, '无权访问该预约'],
        [ErrorCode.FORBIDDEN, '无权限'],
      ).map((example) => ({ example })),
    },
  })
  @ApiNotFoundResponse({
    description: '预约不存在（404 / 32001）或该预约还没有评价（404 / 34001）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.APPOINTMENT_NOT_FOUND, '预约不存在'],
        [ErrorCode.REVIEW_NOT_FOUND, '该预约还没有评价'],
      ).map((example) => ({ example })),
    },
  })
  async findOne(
    @Param() params: AppointmentParamDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<ReviewResponseDto> {
    return this.reviewService.findByAppointment(BigInt(params.id), caller);
  }
}
