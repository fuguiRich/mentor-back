import { Module } from '@nestjs/common';
import { OpLogController } from './oplog.controller';
import { OpLogRepository } from './oplog.repository';
import { OpLogService } from './oplog.service';

/**
 * 操作日志只读接口 + 写入服务。导出 OpLogService 是给业务模块用的——
 * 没有它，这张表永远是空的，运维审计页就是一个谎。
 */
@Module({
  controllers: [OpLogController],
  providers: [OpLogService, OpLogRepository],
  exports: [OpLogService],
})
export class OpLogModule {}
