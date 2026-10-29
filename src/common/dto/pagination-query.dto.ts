import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

/**
 * 分页查询基类（规范 DTO-10）。列表接口的查询 DTO 一律继承它，
 * 不要各写一套 page / pageSize——三套分页参数就是三套前端解析。
 *
 * `pageSize` 的上限不是可选项（DTO-10 的原文）：不设上限的 pageSize
 * 是一个随时会被触发的拒绝服务入口，`?pageSize=1000000` 一次请求
 * 就能把数据库与内存打满。
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({
    description: '页码，从 1 开始；不传时为 1',
    example: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    description: '每页条数，最大 100；不传时为 20',
    example: 20,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}
