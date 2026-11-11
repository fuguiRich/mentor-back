import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt } from 'class-validator';

/** `PATCH /archives/:id/core`：切换核心 / 非核心 */
export class UpdateArchiveCoreDto {
  @ApiProperty({
    description: '1 核心（永久保存）/ 0 非核心（到期清理）',
    enum: [0, 1],
    example: 1,
  })
  @IsInt({ message: 'core 必须是 0 或 1' })
  @IsIn([0, 1], { message: 'core 必须是 0 或 1' })
  core!: number;
}
