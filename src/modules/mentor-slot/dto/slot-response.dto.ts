import { ApiProperty } from '@nestjs/swagger';
import { SLOT_STATUS } from './create-slot.dto';

/** 一条可指导时段的响应形状（RES-04：显式映射，不序列化实体） */
export class SlotResponseDto {
  @ApiProperty({ description: '时段行 ID（BIGINT 对外字符串）', example: '1' })
  id!: string;

  @ApiProperty({
    description: '所属导师档案 ID（BIGINT 对外字符串）',
    example: '1',
  })
  mentorProfileId!: string;

  @ApiProperty({
    description: '星期几：1 周一 … 7 周日',
    enum: [1, 2, 3, 4, 5, 6, 7],
    example: 1,
  })
  weekday!: number;

  @ApiProperty({ description: '开始时间，`HH:mm`', example: '09:00' })
  startTime!: string;

  @ApiProperty({ description: '结束时间，`HH:mm`', example: '11:00' })
  endTime!: string;

  @ApiProperty({
    description: '0 关闭 | 1 开放',
    enum: [SLOT_STATUS.CLOSED, SLOT_STATUS.OPEN],
    example: SLOT_STATUS.OPEN,
  })
  status!: number;
}

/**
 * `GET /mentor/slots` 的响应（RES-06 的统一分页结构）。
 *
 * 导师的时段条数天然有界（一周 7 天），所以一次全量返回、不分页参数：
 * `page` 恒 1、`pageSize` 恒等于 `total`——与 mentor-material 的列表同口径。
 */
export class SlotListResponseDto {
  @ApiProperty({
    description: '该导师的全部未删时段（weekday 升序、同日按开始时间升序）',
    type: [SlotResponseDto],
  })
  list!: SlotResponseDto[];

  @ApiProperty({ description: '时段总数', example: 2 })
  total!: number;

  @ApiProperty({ description: '页码，恒为 1（全量一页）', example: 1 })
  page!: number;

  @ApiProperty({ description: '每页条数，恒等于 total', example: 2 })
  pageSize!: number;
}
