import { ApiProperty } from '@nestjs/swagger';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

/** 考核下的申诉路由参数：`:id` + `:appealId` */
export class AppealParamDto {
  @ApiProperty({
    description: '考核行 ID（Assessment.id，BIGINT 对外字符串）',
    example: '1',
  })
  @IsBigIntId({ message: '考核 ID 必须是合法的数字 ID' })
  id!: string;

  @ApiProperty({
    description: '申诉行 ID（AssessmentAppeal.id，BIGINT 对外字符串）',
    example: '1',
  })
  @IsBigIntId({ message: '申诉 ID 必须是合法的数字 ID' })
  appealId!: string;
}
