import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
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
import type { RequestUser } from '../../common/context/request-context';
import { errExample } from '../../common/dto/err-example';
import { ListMessageQueryDto } from './dto/list-message-query.dto';
import { MessageParamDto } from './dto/message-param.dto';
import {
  MessageListResponseDto,
  MessageResponseDto,
} from './dto/message-response.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { SendReminderDto } from './dto/send-reminder.dto';
import { WorkProgressResponseDto } from './dto/work-progress.dto';
import { MessageService } from './message.service';

/**
 * 消息 / 提醒 / 工作进度（P5 Task 58 / §4.5）。
 *
 * 消息是**个人**资源：三条路由都 `@DataScope('self')`，服务层再按
 * `recipientUserId = caller.userId` 收窄。工作进度与提醒是管理员视角。
 */
@ApiTags('消息与提醒')
@Controller()
export class MessageController {
  constructor(private readonly messageService: MessageService) {}

  @Get('work-progress')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('work:progress')
  @DataScope('all')
  @ApiOperation({
    summary: '导师工作进度（§4.5）',
    description:
      '三个节点：待确认预约（`status = 0`）、逾期未填指导记录（`status = 1`、' +
      '`requestedTime < now` 且无记录）、当前学期待处理考核（`status ∈ {0,1}`）。' +
      '双创学院看全校；学院管理员按导师所在部门只看本院。',
  })
  @ApiOkResponse({
    type: WorkProgressResponseDto,
    description: '工作进度（200）',
  })
  @ApiForbiddenResponse({
    description: '缺权限码 work:progress（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async workProgress(
    @CurrentUser() caller: RequestUser,
  ): Promise<WorkProgressResponseDto> {
    return this.messageService.getWorkProgress(caller);
  }

  @Post('reminders')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('reminder:send')
  @DataScope('all')
  @ApiOperation({
    summary: '发送站内提醒（§4.5）',
    description:
      '对计数 > 0 的导师发一条站内消息。`mentorProfileIds` 省略 = 范围内全部；' +
      '显式指定时任何一个不在数据范围 → **403 / 10003**。没有 `SysUser` 的导师' +
      '计入 `skipped`。响应 `{ sent, skipped }`。',
  })
  @ApiBody({ type: SendReminderDto })
  @ApiCreatedResponse({
    description: '发送结果（201）',
    schema: {
      example: { code: 0, message: 'success', data: { sent: 2, skipped: 0 } },
    },
  })
  @ApiBadRequestResponse({
    description: 'type / mentorProfileIds 非法（400 / 10001）',
    schema: { example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败') },
  })
  @ApiForbiddenResponse({
    description: '缺权限码或指定了范围外导师（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async sendReminders(
    @Body() dto: SendReminderDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<{ sent: number; skipped: number }> {
    return this.messageService.sendReminders(dto, caller);
  }

  @Get('messages')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('message:list')
  @DataScope('self')
  @ApiOperation({
    summary: '我的消息',
    description:
      '只返回当前登录者的消息，按 `createdAt DESC`。`read` 0 未读 / 1 已读；' +
      '`type` 1–3。响应里的 `unread` 是未读总数（不受分页影响）。',
  })
  @ApiOkResponse({
    type: MessageListResponseDto,
    description: '消息列表（200）',
  })
  @ApiForbiddenResponse({
    description: '缺权限码 message:list（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async listMessages(
    @Query() query: ListMessageQueryDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<MessageListResponseDto> {
    return this.messageService.listMessages(query, caller);
  }

  @Get('messages/unread-count')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('message:list')
  @DataScope('self')
  @ApiOperation({
    summary: '我的未读消息数',
    description: '只统计当前登录者的未读消息；导航栏 / 首页角标用，轻量接口。',
  })
  @ApiOkResponse({
    description: '未读数（200）',
    schema: { example: { code: 0, message: 'success', data: { unread: 3 } } },
  })
  async unreadCount(
    @CurrentUser() caller: RequestUser,
  ): Promise<{ unread: number }> {
    return this.messageService.getUnreadCount(caller);
  }

  @Post('messages')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('message:send')
  @DataScope('all')
  @ApiOperation({
    summary: '新建站内消息（管理员）',
    description:
      '消息类型固定为 `4 系统通知`。收件人两种模式二选一：' +
      '`recipientUserIds` 精确指定，或 `recipientRoleCodes` / `deptId` 群发（AND）。' +
      '学院管理员只能发给本院（及下级）用户；显式收件人越界 → **403 / 10003**。' +
      '响应 `{ sent, skipped }`。',
  })
  @ApiBody({ type: SendMessageDto })
  @ApiCreatedResponse({
    description: '发送结果（201）',
    schema: {
      example: { code: 0, message: 'success', data: { sent: 2, skipped: 0 } },
    },
  })
  @ApiBadRequestResponse({
    description:
      '收件人条件缺失 / 两种模式同时出现 / 标题正文越界（400 / 10001）',
    schema: { example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败') },
  })
  @ApiForbiddenResponse({
    description: '缺权限码或收件人越界（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async sendMessage(
    @Body() dto: SendMessageDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<{ sent: number; skipped: number }> {
    return this.messageService.sendMessage(dto, caller);
  }

  @Patch('messages/:id/read')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('message:list')
  @DataScope('self')
  @ApiOperation({
    summary: '标记消息已读（已读回执）',
    description:
      '只认自己的消息；别人的 / 不存在 → **404 / 38001**（藏存在性）。' +
      '重复标记幂等，`readAt` 不会被刷新。',
  })
  @ApiOkResponse({ type: MessageResponseDto, description: '已读消息（200）' })
  @ApiNotFoundResponse({
    description: '消息不存在 / 不属于本人（404 / 38001）',
    schema: { example: errExample(ErrorCode.MESSAGE_NOT_FOUND, '消息不存在') },
  })
  async markRead(
    @Param() params: MessageParamDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<MessageResponseDto> {
    return this.messageService.markRead(BigInt(params.id), caller);
  }

  @Post('messages/read-all')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('message:list')
  @DataScope('self')
  @ApiOperation({
    summary: '全部标为已读',
    description: '只清自己的未读；响应 `{ updated }`，第二次为 0。',
  })
  @ApiCreatedResponse({
    description: '更新条数（201）',
    schema: { example: { code: 0, message: 'success', data: { updated: 2 } } },
  })
  async markAllRead(
    @CurrentUser() caller: RequestUser,
  ): Promise<{ updated: number }> {
    return this.messageService.markAllRead(caller);
  }
}
