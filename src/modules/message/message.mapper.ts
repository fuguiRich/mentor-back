import type { Message } from '@prisma/client';
import type { MessageResponseDto } from './dto/message-response.dto';

/** 实体 → 响应 DTO（RES-04：显式映射） */
export function toMessageResponse(row: Message): MessageResponseDto {
  return {
    id: row.id.toString(),
    type: row.type,
    title: row.title,
    content: row.content,
    bizType: row.bizType,
    bizId: row.bizId,
    readAt: row.readAt === null ? null : row.readAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
