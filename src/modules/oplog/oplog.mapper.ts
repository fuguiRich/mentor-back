import type { SysOpLog } from '@prisma/client';
import type { OpLogResponseDto } from './dto/oplog-response.dto';

/** 实体 → Response DTO 的显式映射（规范 RES-04，同 dept.mapper.ts） */
export function toOpLogResponse(entity: SysOpLog): OpLogResponseDto {
  return {
    id: entity.id.toString(),
    module: entity.module,
    action: entity.action,
    targetType: entity.targetType,
    targetId: entity.targetId,
    operatorId: entity.createdBy.toString(),
    operatorName: entity.operatorName,
    method: entity.method,
    path: entity.path,
    ip: entity.ip,
    userAgent: entity.userAgent,
    status: entity.status,
    errorCode: entity.errorCode,
    errorMsg: entity.errorMsg,
    before: entity.before,
    after: entity.after,
    durationMs: entity.durationMs,
    createdAt: entity.createdAt.toISOString(),
  };
}
