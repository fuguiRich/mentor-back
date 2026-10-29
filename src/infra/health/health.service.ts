import { Injectable } from '@nestjs/common';
import { HealthRepository } from './health.repository';
import { DependenciesDto, HealthResponseDto } from './dto/health-response.dto';

@Injectable()
export class HealthService {
  constructor(private readonly repository: HealthRepository) {}

  /** 两个探针并发跑：串行的话探活耗时是两个依赖超时之和 */
  async check(): Promise<HealthResponseDto> {
    const [database, redis] = await Promise.all([
      this.repository.probeDatabase(),
      this.repository.probeRedis(),
    ]);

    const dependencies: DependenciesDto = { database, redis };

    return {
      status:
        database.status === 'up' && redis.status === 'up' ? 'ok' : 'error',
      dependencies,
    };
  }
}
