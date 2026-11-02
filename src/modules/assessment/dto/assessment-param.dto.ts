import { ApiProperty } from '@nestjs/swagger';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

/** `POST /assessments/:id/college-review` 等按考核 ID 操作的路由参数 */
export class AssessmentParamDto {
  @ApiProperty({
    description: '考核行 ID（Assessment.id，BIGINT 对外字符串）',
    example: '1',
  })
  @IsBigIntId({ message: '考核 ID 必须是合法的数字 ID' })
  id!: string;
}
