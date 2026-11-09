import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCode } from '../../common/constants/error-code';
import type { DataScopeFilter } from '../../common/constants/data-scope';
import {
  currentDataScopeCeiling,
  type RequestUser,
} from '../../common/context/request-context';
import { BusinessException } from '../../common/errors/business.exception';
import { currentPeriod } from '../assessment/assessment.constants';
import { DataScopeService } from '../data-scope/data-scope.service';
import { UserService } from '../user/user.service';
import type { ListMessageQueryDto } from './dto/list-message-query.dto';
import type {
  MessageListResponseDto,
  MessageResponseDto,
} from './dto/message-response.dto';
import type { SendMessageDto } from './dto/send-message.dto';
import type { SendReminderDto } from './dto/send-reminder.dto';
import type {
  WorkProgressMentorDto,
  WorkProgressResponseDto,
} from './dto/work-progress.dto';
import { toMessageResponse } from './message.mapper';
import {
  MessageRepository,
  type MessageRecipient,
  type MessageWrite,
  type VisibleMentor,
} from './message.repository';

/** 管理员新建消息的固定类型：4 系统通知 */
const SYSTEM_MESSAGE_TYPE = 4;

/** 提醒类型 → 消息类型 */
const MESSAGE_TYPE_BY_REMINDER = {
  'pending-appointments': 1,
  'record-missing': 2,
  'assessment-pending': 3,
} as const;

/**
 * 消息 / 提醒 / 工作进度（P5 Task 58 / §4.5）。
 *
 * 三条不变量：
 * 1. **消息只属于收件人**：列表按 `recipientUserId = caller.userId` 过滤；
 *    标记别人的消息 → 404（藏存在性）。
 * 2. **提醒按数据范围发**：学院管理员只能提醒本院导师；显式指定的导师
 *    有一个不在范围内就整体 403（不静默跳过）。
 * 3. **只对计数 > 0 的导师发**：提醒正文里的数字是真实待办数；
 *    发一条「您有 0 条」的提醒只会训练用户忽略消息。
 */
@Injectable()
export class MessageService {
  constructor(
    private readonly repository: MessageRepository,
    private readonly users: UserService,
    private readonly dataScope: DataScopeService,
  ) {}

  /** `GET /work-progress` —— 范围内导师的待办节点 */
  async getWorkProgress(caller: RequestUser): Promise<WorkProgressResponseDto> {
    const deptIds = await this.resolveDeptIds(caller);
    const mentors = await this.repository.findVisibleMentors(deptIds);
    const rows = await this.progressFor(mentors);
    return this.summarize(rows);
  }

  /**
   * `POST /reminders` —— 给计数 > 0 的导师发站内消息。
   *
   * 没有 `SysUser` 的导师计入 `skipped`（消息没有收件人可落）。
   */
  async sendReminders(
    dto: SendReminderDto,
    caller: RequestUser,
  ): Promise<{ sent: number; skipped: number }> {
    const deptIds = await this.resolveDeptIds(caller);
    const visible = await this.repository.findVisibleMentors(deptIds);

    let targets = visible;
    if (dto.mentorProfileIds !== undefined) {
      const requested = new Set(dto.mentorProfileIds.map((id) => BigInt(id)));
      const visibleIds = new Set(visible.map((mentor) => mentor.id.toString()));
      for (const id of requested) {
        if (!visibleIds.has(id.toString())) {
          throw this.forbidden();
        }
      }
      targets = visible.filter((mentor) => requested.has(mentor.id));
    }

    const rows = await this.progressFor(targets);
    const period = currentPeriod();
    const countOf = (row: WorkProgressMentorDto): number => {
      switch (dto.type) {
        case 'pending-appointments':
          return row.pendingAppointments;
        case 'record-missing':
          return row.missingRecords;
        case 'assessment-pending':
          return row.pendingAssessments;
      }
    };

    const usersByLogin = await this.repository.findActiveUsersByLogins(
      targets.map((mentor) => mentor.login),
    );
    const mentorById = new Map(
      targets.map((mentor) => [mentor.id.toString(), mentor]),
    );

    const writes: MessageWrite[] = [];
    let skipped = 0;
    for (const row of rows) {
      const count = countOf(row);
      if (count === 0) {
        continue;
      }
      const mentor = mentorById.get(row.mentorProfileId);
      if (mentor === undefined) {
        continue;
      }
      const recipientUserId = usersByLogin.get(mentor.login);
      if (recipientUserId === undefined) {
        skipped += 1;
        continue;
      }
      const reminder = this.buildReminder(dto.type, count, period);
      writes.push({
        recipientUserId,
        type: reminder.type,
        title: reminder.title,
        content: reminder.content,
        bizType: 'MentorProfile',
        bizId: mentor.id.toString(),
      });
    }

    for (const write of writes) {
      await this.repository.create(write);
    }
    return { sent: writes.length, skipped };
  }

  /**
   * `POST /messages` —— 管理员新建站内消息。
   *
   * 收件人两种模式二选一：精确用户 ID，或角色 / 部门群发。消息类型固定
   * `4 系统通知`。学院管理员只能发本院（及下级）用户；显式指定的收件人
   * 有一个越界就整体 403。
   */
  async sendMessage(
    dto: SendMessageDto,
    caller: RequestUser,
  ): Promise<{ sent: number; skipped: number }> {
    const title = dto.title.trim();
    const content = dto.content.trim();
    if (title === '' || content === '') {
      throw this.badRequest('标题和正文不能为空');
    }

    const hasUsers = dto.recipientUserIds !== undefined;
    const hasSelector =
      dto.recipientRoleCodes !== undefined || dto.deptId !== undefined;
    if (hasUsers && hasSelector) {
      throw this.badRequest(
        'recipientUserIds 与 recipientRoleCodes/deptId 只能二选一',
      );
    }
    if (!hasUsers && !hasSelector) {
      throw this.badRequest('至少指定一个收件人条件');
    }
    if (hasUsers && dto.recipientUserIds?.length === 0) {
      throw this.badRequest('recipientUserIds 不能为空');
    }
    if (
      dto.recipientRoleCodes !== undefined &&
      dto.recipientRoleCodes.length === 0
    ) {
      throw this.badRequest('recipientRoleCodes 不能为空');
    }

    const deptIds = await this.resolveDeptIds(caller);
    const recipients = hasUsers
      ? await this.resolveExplicitRecipients(
          dto.recipientUserIds ?? [],
          deptIds,
        )
      : await this.resolveSelectorRecipients(dto, deptIds);

    const unique = [
      ...new Map(
        recipients.map((recipient) => [recipient.id.toString(), recipient]),
      ).values(),
    ];
    const writes: MessageWrite[] = unique.map((recipient) => ({
      recipientUserId: recipient.id,
      type: SYSTEM_MESSAGE_TYPE,
      title,
      content,
      bizType: null,
      bizId: null,
    }));
    return { sent: await this.repository.createMany(writes), skipped: 0 };
  }

  private async resolveExplicitRecipients(
    rawIds: readonly string[],
    deptIds: bigint[] | null,
  ): Promise<MessageRecipient[]> {
    const ids = [...new Set(rawIds.map((id) => BigInt(id)))];
    const recipients = await this.repository.findActiveUsersByIds(ids);
    if (recipients.length !== ids.length) {
      throw this.badRequest('收件人不存在或已停用');
    }
    if (
      deptIds !== null &&
      recipients.some(
        (recipient) =>
          recipient.deptId === null || !deptIds.includes(recipient.deptId),
      )
    ) {
      throw this.forbidden();
    }
    return recipients;
  }

  private async resolveSelectorRecipients(
    dto: SendMessageDto,
    deptIds: bigint[] | null,
  ): Promise<MessageRecipient[]> {
    if (dto.recipientRoleCodes !== undefined) {
      const existing = await this.repository.findExistingRoleCodes(
        dto.recipientRoleCodes,
      );
      const missing = dto.recipientRoleCodes.filter(
        (code) => !existing.has(code),
      );
      if (missing.length > 0) {
        throw this.badRequest(`角色不存在：${missing.join(', ')}`);
      }
    }
    const deptId = dto.deptId === undefined ? undefined : BigInt(dto.deptId);
    if (deptId !== undefined && deptIds !== null && !deptIds.includes(deptId)) {
      throw this.forbidden();
    }
    return this.repository.findActiveUsersBySelector({
      ...(dto.recipientRoleCodes === undefined
        ? {}
        : { roleCodes: dto.recipientRoleCodes }),
      ...(deptId === undefined ? {} : { deptId }),
      deptIds,
    });
  }

  /** `GET /messages` —— 只读自己的消息 */
  async listMessages(
    query: ListMessageQueryDto,
    caller: RequestUser,
  ): Promise<MessageListResponseDto> {
    const filter = {
      ...(query.read === undefined ? {} : { read: query.read }),
      ...(query.type === undefined ? {} : { type: query.type }),
    };
    const [pageResult, unread] = await Promise.all([
      this.repository.findPage(
        caller.userId,
        filter,
        (query.page - 1) * query.pageSize,
        query.pageSize,
      ),
      this.repository.countUnread(caller.userId),
    ]);
    const [list, total] = pageResult;
    const senderNames = await this.repository.findSenderNames([
      ...new Set(
        list.filter((row) => row.createdBy !== 0n).map((row) => row.createdBy),
      ),
    ]);
    return {
      list: list.map((row) =>
        toMessageResponse(
          row,
          senderNames.get(row.createdBy.toString()) ?? null,
        ),
      ),
      total,
      page: query.page,
      pageSize: query.pageSize,
      unread,
    };
  }

  /** `GET /messages/unread-count` —— 轻量未读数（角标用） */
  async getUnreadCount(caller: RequestUser): Promise<{ unread: number }> {
    return { unread: await this.repository.countUnread(caller.userId) };
  }

  /** `PATCH /messages/:id/read` */
  async markRead(id: bigint, caller: RequestUser): Promise<MessageResponseDto> {
    const row = await this.repository.markRead(id, caller.userId);
    if (row === null) {
      throw new BusinessException(
        ErrorCode.MESSAGE_NOT_FOUND,
        '消息不存在',
        HttpStatus.NOT_FOUND,
      );
    }
    const senderName =
      row.createdBy === 0n
        ? null
        : ((await this.repository.findSenderNames([row.createdBy])).get(
            row.createdBy.toString(),
          ) ?? null);
    return toMessageResponse(row, senderName);
  }

  /** `POST /messages/read-all` */
  async markAllRead(caller: RequestUser): Promise<{ updated: number }> {
    return { updated: await this.repository.markAllRead(caller.userId) };
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  private async progressFor(
    mentors: readonly VisibleMentor[],
  ): Promise<WorkProgressMentorDto[]> {
    const ids = mentors.map((mentor) => mentor.id);
    const period = currentPeriod();
    const [pending, missing, assessments] = await Promise.all([
      this.repository.countPendingAppointments(ids),
      this.repository.countMissingRecords(ids, new Date()),
      this.repository.countPendingAssessments(ids, period),
    ]);

    return mentors.map((mentor) => {
      const key = mentor.id.toString();
      return {
        mentorProfileId: key,
        mentorName: mentor.realName,
        deptId: mentor.deptId === null ? null : mentor.deptId.toString(),
        pendingAppointments: pending.get(key) ?? 0,
        missingRecords: missing.get(key) ?? 0,
        pendingAssessments: assessments.get(key) ?? 0,
      };
    });
  }

  private summarize(
    rows: readonly WorkProgressMentorDto[],
  ): WorkProgressResponseDto {
    return {
      totalMentors: rows.length,
      pendingAppointments: rows.reduce(
        (sum, row) => sum + row.pendingAppointments,
        0,
      ),
      missingRecords: rows.reduce((sum, row) => sum + row.missingRecords, 0),
      pendingAssessments: rows.reduce(
        (sum, row) => sum + row.pendingAssessments,
        0,
      ),
      mentors: [...rows],
    };
  }

  private buildReminder(
    type: SendReminderDto['type'],
    count: number,
    period: string,
  ): { type: number; title: string; content: string } {
    const messageType = MESSAGE_TYPE_BY_REMINDER[type];
    switch (type) {
      case 'pending-appointments':
        return {
          type: messageType,
          title: '预约待处理提醒',
          content: `您有 ${count} 条预约待确认，请及时处理。`,
        };
      case 'record-missing':
        return {
          type: messageType,
          title: '指导记录待填写提醒',
          content: `您有 ${count} 条已确认预约尚未填写指导记录，请及时补填。`,
        };
      case 'assessment-pending':
        return {
          type: messageType,
          title: '考核待处理提醒',
          content: `您在 ${period} 的考核尚未完成，请及时处理。`,
        };
    }
  }

  /**
   * 工作进度 / 提醒的部门范围：`all` → 全校（null），`depts` → 这些部门，
   * `self` → 403（§4.5 是管理员视角，导师不该拿这个码）。
   */
  private async resolveDeptIds(caller: RequestUser): Promise<bigint[] | null> {
    const scope = await this.resolveScope(caller);
    if (scope.kind === 'all') {
      return null;
    }
    if (scope.kind === 'depts') {
      return scope.deptIds;
    }
    throw this.forbidden();
  }

  private async resolveScope(caller: RequestUser): Promise<DataScopeFilter> {
    const user = await this.users.findById(caller.userId);
    return this.dataScope.resolve(
      {
        userId: caller.userId,
        isSuperAdmin: caller.isSuperAdmin,
        deptId: user?.deptId ?? null,
      },
      currentDataScopeCeiling(),
    );
  }

  private forbidden(): BusinessException {
    return new BusinessException(
      ErrorCode.FORBIDDEN,
      '无权限',
      HttpStatus.FORBIDDEN,
    );
  }

  private badRequest(message: string): BusinessException {
    return new BusinessException(
      ErrorCode.PARAM_INVALID,
      message,
      HttpStatus.BAD_REQUEST,
    );
  }
}
