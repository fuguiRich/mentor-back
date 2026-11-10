import { ApiProperty } from '@nestjs/swagger';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

/** 归档附件的路由参数：`:id` + `:fileId`（都是 BIGINT 字符串） */
export class ArchiveFileParamDto {
  @ApiProperty({ description: '归档条目 ID', example: '1' })
  @IsBigIntId({ message: 'id 必须是合法的数字 ID' })
  id!: string;

  @ApiProperty({ description: '文件 ID', example: '12' })
  @IsBigIntId({ message: 'fileId 必须是合法的数字 ID' })
  fileId!: string;
}
