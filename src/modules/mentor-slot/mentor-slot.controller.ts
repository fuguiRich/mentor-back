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
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
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
import { NoEnvelope } from '../../common/decorators/no-envelope.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CreateSlotDto } from './dto/create-slot.dto';
import { SlotParamDto } from './dto/slot-param.dto';
import { SlotListResponseDto, SlotResponseDto } from './dto/slot-response.dto';
import { UpdateSlotDto } from './dto/update-slot.dto';
import { MentorSlotService } from './mentor-slot.service';

/**
 * 导师可指导时段（Task 21）——**恰好 4 条路由**，全部 `mentor:slot-manage` +
 * `@DataScope('self')`。
 *
 * 只能操作**自己的**时段：身份链解析出本人的 `MentorProfile`，别人的 `:id`
 * 一律 **404 / 31201**（藏存在性，不是 403）。同一导师同一 weekday 的时段
 * 不得重叠（半开区间），冲突 **409 / 31206**；导师无档案 **404 / 31102**。
 */
@ApiTags('导师时段')
@Controller('mentor/slots')
export class MentorSlotController {
  constructor(private readonly mentorSlotService: MentorSlotService) {}

  @Get()
  @RequirePermission('mentor:slot-manage')
  @DataScope('self')
  @ApiOperation({
    summary: '查询我的可指导时段',
    description:
      '返回本人（按身份链解析出的导师档案）的全部**未删**时段，' +
      '按 weekday 升序、同日按开始时间升序。全量一页（导师的时段条数天然有界），' +
      '`page` 恒 1、`pageSize` 恒等于 `total`。' +
      '导师无档案（`MentorProfile` 不存在，含学生）→ **404 / 31102**。',
  })
  @ApiOkResponse({
    type: SlotListResponseDto,
    description: '本人的可指导时段列表',
  })
  @ApiNotFoundResponse({
    description: '导师专业档案不存在（404 / 31102）',
    schema: {
      example: errExample(
        ErrorCode.MENTOR_PROFILE_NOT_FOUND,
        '导师专业档案不存在',
      ),
    },
  })
  async list(@CurrentUser() caller: RequestUser): Promise<SlotListResponseDto> {
    return this.mentorSlotService.list(caller);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('mentor:slot-manage')
  @DataScope('self')
  @ApiOperation({
    summary: '新建可指导时段',
    description:
      '请求体 `{ weekday, startTime, endTime, status? }`：' +
      '`weekday` 1 周一 … 7 周日（0 / 8 / 非整数 → **400 / 10001**，' +
      '`data.fields` 点名 weekday）；`startTime` / `endTime` 为 `HH:mm`' +
      '（`25:00` 等非法格式 → 400 / 10001），且 **endTime 必须严格晚于 startTime**' +
      '（否则 400 / 10001，点名 endTime）；`status` 省略 = **1 开放**（0 关闭 / 1 开放），' +
      '显式 `null` 不合法（400 / 10001，点名 status）。' +
      '同一导师**同一 weekday 的时段不得重叠**（半开区间 `[start, end)`，首尾相接不算）' +
      '→ **409 / 31206**。导师无档案 → **404 / 31102**。',
  })
  @ApiBody({ type: CreateSlotDto })
  @ApiCreatedResponse({
    type: SlotResponseDto,
    description: '创建成功（201），返回新建的时段',
  })
  @ApiBadRequestResponse({
    description:
      'weekday 越界 / 时间格式非法 / endTime 不晚于 startTime / status 非 0 或 1（含 null）/ 未知字段（400 / 10001）',
    schema: {
      example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败'),
    },
  })
  @ApiNotFoundResponse({
    description: '导师专业档案不存在（404 / 31102）',
    schema: {
      example: errExample(
        ErrorCode.MENTOR_PROFILE_NOT_FOUND,
        '导师专业档案不存在',
      ),
    },
  })
  @ApiConflictResponse({
    description: '与本人同 weekday 的已有开放时段重叠（409 / 31206）',
    schema: {
      example: errExample(
        ErrorCode.MENTOR_SLOT_OVERLAP,
        '该时段与已有开放时段重叠',
      ),
    },
  })
  async create(
    @Body() dto: CreateSlotDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<SlotResponseDto> {
    return this.mentorSlotService.create(dto, caller);
  }

  @Put(':id')
  @RequirePermission('mentor:slot-manage')
  @DataScope('self')
  @ApiOperation({
    summary: '修改可指导时段',
    description:
      '整条替换（`weekday` / `startTime` / `endTime` 必填，`status` 可省略 = **保留原值**），' +
      '请求体约束与新建一致（400 / 10001 的字段点名规则相同；`status` 显式 `null` → 400）。' +
      '`:id` 不存在 / 已软删 / **不属于本人** → **404 / 31201**（藏存在性，不是 403）。' +
      '重叠判定排除自己那一行；与本人同 weekday 的其它时段相交 → **409 / 31206**。' +
      '导师无档案 → **404 / 31102**。',
  })
  @ApiBody({ type: UpdateSlotDto })
  @ApiOkResponse({
    type: SlotResponseDto,
    description: '修改成功，返回修改后的时段',
  })
  @ApiBadRequestResponse({
    description:
      'weekday 越界 / 时间格式非法 / endTime 不晚于 startTime / status 非 0 或 1（含 null）/ 未知字段（400 / 10001）',
    schema: {
      example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败'),
    },
  })
  @ApiNotFoundResponse({
    description:
      '导师专业档案不存在（404 / 31102）或时段不存在 / 不属于本人（404 / 31201）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.MENTOR_PROFILE_NOT_FOUND, '导师专业档案不存在'],
        [ErrorCode.MENTOR_SLOT_NOT_FOUND, '可指导时段不存在'],
      ).map((example) => ({ example })),
    },
  })
  @ApiConflictResponse({
    description: '与本人同 weekday 的其它开放时段重叠（409 / 31206）',
    schema: {
      example: errExample(
        ErrorCode.MENTOR_SLOT_OVERLAP,
        '该时段与已有开放时段重叠',
      ),
    },
  })
  async update(
    @Param() params: SlotParamDto,
    @Body() dto: UpdateSlotDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<SlotResponseDto> {
    return this.mentorSlotService.update(BigInt(params.id), dto, caller);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @NoEnvelope()
  @RequirePermission('mentor:slot-manage')
  @DataScope('self')
  @ApiOperation({
    summary: '删除可指导时段（软删）',
    description:
      '**无请求体**（出现字段 → 400 / 10001）。删除是**软删**（打 `deletedAt` / ' +
      '`deletedBy`）：删除后列表不再返回它、不参与重叠判断，同一 weekday 同一时间' +
      '可以重新创建。`:id` 不存在 / 已软删 / **不属于本人** → **404 / 31201**' +
      '（藏存在性，不是 403）。导师无档案 → **404 / 31102**。',
  })
  @ApiNoContentResponse({ description: '删除成功（204），响应体为空' })
  @ApiNotFoundResponse({
    description:
      '导师专业档案不存在（404 / 31102）或时段不存在 / 不属于本人（404 / 31201）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.MENTOR_PROFILE_NOT_FOUND, '导师专业档案不存在'],
        [ErrorCode.MENTOR_SLOT_NOT_FOUND, '可指导时段不存在'],
      ).map((example) => ({ example })),
    },
  })
  @ApiForbiddenResponse({
    description: '缺权限码（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async remove(
    @Param() params: SlotParamDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<void> {
    await this.mentorSlotService.remove(BigInt(params.id), caller);
  }
}
