import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { toNumberIfNumericString } from '../../appointment/dto/create-appointment.dto';
import { MESSAGE_TYPES } from './message-response.dto';

/** `GET /messages` 的查询参数 */
export class ListMessageQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '已读状态：0 未读 / 1 已读；不传为全部',
    enum: [0, 1],
    example: 0,
  })
  @IsOptional()
  @Transform(toNumberIfNumericString)
  @IsInt()
  @Min(0)
  @IsIn([0, 1], { message: 'read 只能是 0 或 1' })
  read?: number;

  @ApiPropertyOptional({
    description:
      '消息类型：1 预约待处理 / 2 指导记录待填写 / 3 考核待处理 / 4 系统通知',
    enum: MESSAGE_TYPES,
    example: 1,
  })
  @IsOptional()
  @Transform(toNumberIfNumericString)
  @IsInt()
  @IsIn([...MESSAGE_TYPES], { message: 'type 必须是 1 / 2 / 3 / 4' })
  type?: number;
}
