import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

/** `POST /assessments/:id/appeals` 的请求体（§3.8） */
export class CreateAppealDto {
  @ApiProperty({
    description: '申诉说明，1-1000 字',
    example: '本年度指导 15 次、成果 3 项，初评材料遗漏了省级奖项，请复核。',
  })
  @IsString({ message: 'reason 必须是字符串' })
  @Length(1, 1000, { message: 'reason 长度必须是 1-1000 个字符' })
  reason!: string;

  @ApiPropertyOptional({
    description:
      '佐证附件（SysFile.id 数组，最多 10 个）；先走 `POST /files` 上传',
    type: [String],
    example: ['12', '13'],
  })
  @IsOptional()
  @IsArray({ message: 'fileIds 必须是数组' })
  @ArrayMaxSize(10, { message: '申诉附件最多 10 个' })
  @IsBigIntId({ each: true, message: 'fileIds 必须是数字 ID 数组' })
  fileIds?: string[];
}
