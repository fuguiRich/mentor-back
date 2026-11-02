import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/** `POST /assessments/:id/appeals` 的请求体（§3.8） */
export class CreateAppealDto {
  @ApiProperty({
    description: '申诉说明，1-1000 字',
    example: '本年度指导 15 次、成果 3 项，初评材料遗漏了省级奖项，请复核。',
  })
  @IsString({ message: 'reason 必须是字符串' })
  @Length(1, 1000, { message: 'reason 长度必须是 1-1000 个字符' })
  reason!: string;
}
