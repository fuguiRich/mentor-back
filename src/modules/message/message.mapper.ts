import type { Message } from '@prisma/client';
import type { MessageResponseDto } from './dto/message-response.dto';

/** 实体 → 响应 DTO（RES-04：显式映射） */
export function toMessageResponse(
  row: Message,
  senderName: string | null = null,
): MessageResponseDto {
  return {
    id: row.id.toString(),
    type: row.type,
    title: row.title,
    content: row.content,
    senderUserId: row.createdBy === 0n ? null : row.createdBy.toString(),
    senderName: row.createdBy === 0n ? null : senderName,
    bizType: row.bizType,
    bizId: row.bizId,
    readAt: row.readAt === null ? null : row.readAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
