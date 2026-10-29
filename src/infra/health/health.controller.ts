import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { HealthService } from './health.service';
import { HealthResponseDto } from './dto/health-response.dto';

@ApiTags('健康检查')
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({
    summary: '探活：检查数据库与 Redis 连通性',
    description:
      '供负载均衡与监控系统周期调用，判断服务本身及其依赖是否可用。' +
      '每次调用都会真实访问 MySQL 与 Redis（两者并发探测，耗时取较长者）；' +
      '依赖不通时这里不会返回失败状态码，而是把对应依赖标为 down 并给出原因。' +
      '本接口免登录：探活要被负载均衡与监控在没有凭据的情况下调用，全局守卫对它显式放行（@Public）。',
  })
  // 本接口刻意没有失败响应示例：HealthService.check() 永远返回 200，
  // 依赖不通是 200 + status:'error'（由 HealthResponseDto.status 的 enum 表达），
  // HTTP 层不存在失败分支。编造一个 500 示例比缺这个示例更糟。
  // 运维边界的补充（与响应设计无关）：启动期 Redis 不可达时，
  // RedisService.onModuleInit 的 connect() 直接抛错、进程起不来
  // （plan:539 的刻意 fail-fast）；运行期断连只会让请求被 reject、
  // 本接口报 down，进程不崩——「服务起不来」先查 Redis，别在这里找。
  @ApiOkResponse({
    type: HealthResponseDto,
    description:
      '探活完成。依赖不通时仍返回 200，此时 status 为 error，' +
      '具体原因在对应依赖的 message 字段里。',
  })
  async check(): Promise<HealthResponseDto> {
    return this.healthService.check();
  }
}
