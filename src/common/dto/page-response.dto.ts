import { ApiProperty } from '@nestjs/swagger';

/**
 * 列表接口统一分页结构（规范 RES-06）：{ list, total, page, pageSize }。
 * 具体列表响应继承它，并**重写** list 的 `@ApiProperty({ type: () => Xxx, isArray: true })`
 * ——Swagger 推断不出泛型元素类型，不重写文档里 list 就是空数组（spec 第 6 节 ⑤）。
 */
export class PageResponseDto<T> {
  @ApiProperty({ isArray: true, description: '当前页数据' })
  list!: T[];

  @ApiProperty({ description: '总条数', example: 42 })
  total!: number;

  @ApiProperty({ description: '当前页码', example: 1 })
  page!: number;

  @ApiProperty({ description: '每页条数', example: 20 })
  pageSize!: number;
}
