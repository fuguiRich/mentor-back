import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';
import { PageResponseDto } from '../../../common/dto/page-response.dto';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { OpLogResponseDto } from './oplog-response.dto';

export class OpLogParamDto {
  // `@ApiProperty` 不能省：@nestjs/swagger 只展开带它的属性。少了它，
  // OpenAPI 里 GET /op-logs/{id} 会没有 path 参数——而路径模板里明明有 {id}，
  // 既不合法，也会让「有输入 ⇒ 400」那条判据把这条接口误判成无输入。
  @ApiProperty({ description: '操作日志 ID', example: '1' })
  @IsBigIntId({ message: '操作日志 ID 必须是正整数字符串' })
  id!: string;
}

export class QueryOpLogDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '业务模块，精确匹配',
    example: 'role',
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: '模块长度不能超过 50 个字符' })
  module?: string;

  @ApiPropertyOptional({
    description: '动作，精确匹配',
    example: 'update',
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: '动作长度不能超过 50 个字符' })
  action?: string;

  @ApiPropertyOptional({
    description: '执行结果筛选：1 成功 / 0 失败；不传表示全部',
    example: 0,
    enum: [1, 0],
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn([1, 0], { message: '状态只能是 1（成功）或 0（失败）' })
  status?: number;

  @ApiPropertyOptional({
    description:
      '操作人用户标识（= createdBy）。**不要拿姓名筛**——姓名是写入时的快照，' +
      '没有索引，也没法精确对应到人（改过名的人会有多条不同名字）',
    example: '3',
  })
  @IsOptional()
  @IsBigIntId({ message: '操作人 ID 必须是正整数字符串' })
  operatorId?: string;

  @ApiPropertyOptional({
    description: '目标对象类型，精确匹配',
    example: 'SysRole',
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: '目标类型长度不能超过 50 个字符' })
  targetType?: string;

  @ApiPropertyOptional({
    description: '目标对象标识，精确匹配',
    example: '12',
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: '目标标识长度不能超过 50 个字符' })
  targetId?: string;

  @ApiPropertyOptional({
    description: '发生时间下界（含），ISO 8601；配 endTime 做时间窗',
    example: '2026-10-01T00:00:00.000Z',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate({ message: '发生时间下界必须是合法的 ISO 8601 时间' })
  startTime?: Date;

  @ApiPropertyOptional({
    description: '发生时间上界（含），ISO 8601',
    example: '2026-10-20T23:59:59.999Z',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate({ message: '发生时间上界必须是合法的 ISO 8601 时间' })
  endTime?: Date;
}

export class OpLogPageResponseDto extends PageResponseDto<OpLogResponseDto> {
  // 重写 list 的注解：Swagger 推断不出泛型元素类型（spec 第 6 节 ⑤）。
  // `declare` 是编译要求：target ES2023 下 useDefineForClassFields 为 true
  // （同 role-page-response.dto.ts）。
  @ApiProperty({
    type: () => [OpLogResponseDto],
    description: '当前页的操作日志',
  })
  declare list: OpLogResponseDto[];
}
