import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/** 依赖连通性的探测结果 */
export interface ProbeResult {
  status: 'up' | 'down';
  message?: string;
}

/**
 * 健康探针的数据访问层。
 *
 * 这里不需要软删除过滤与审计填充——SELECT 1 和 PING 都不碰业务表。
 */
@Injectable()
export class HealthRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  probeDatabase(): Promise<ProbeResult> {
    return this.probe(() => this.prisma.client.$queryRaw`SELECT 1`);
  }

  probeRedis(): Promise<ProbeResult> {
    return this.probe(() => this.redis.client.ping());
  }

  /**
   * 探测本身失败不算异常，它就是要报告的事实。
   * 抛出的话，探活接口在依赖挂掉时会返回 500——
   * 而 500 恰恰说明不了是哪个依赖挂了。
   */
  private async probe(run: () => Promise<unknown>): Promise<ProbeResult> {
    try {
      await run();
      return { status: 'up' };
    } catch (error) {
      return {
        status: 'down',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
