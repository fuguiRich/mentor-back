import { ApiProperty } from '@nestjs/swagger';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

/** 申诉附件的路由参数：`:id` + `:appealId` + `:fileId` */
export class AppealFileParamDto {
  @ApiProperty({ description: '考核 ID', example: '1' })
  @IsBigIntId({ message: 'id 必须是合法的数字 ID' })
  id!: string;

  @ApiProperty({ description: '申诉 ID', example: '2' })
  @IsBigIntId({ message: 'appealId 必须是合法的数字 ID' })
  appealId!: string;

  @ApiProperty({ description: '文件 ID', example: '12' })
  @IsBigIntId({ message: 'fileId 必须是合法的数字 ID' })
  fileId!: string;
}
