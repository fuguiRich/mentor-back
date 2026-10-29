import { ApiProperty } from '@nestjs/swagger';
import { ValidationErrorDataDto } from './field-error.dto';

/**
 * 参数校验失败（10001）的响应体形状。
 *
 * 这个类**没有任何接口用它做返回类型**——它是 400 注入（R5）引用的 schema，
 * 所以必须挂在 swaggerExtraModels 里才会出现在 components.schemas。
 * 逐字段清单在 data.fields：前端要能把「哪个字段错在哪」画到表单上，
 * 只给一句「参数校验失败」是不够的。
 */
export class ValidationErrorResponseDto {
  @ApiProperty({
    description: '业务错误码，参数校验失败恒为 10001',
    example: 10001,
  })
  code!: number;

  @ApiProperty({
    description: '错误文案',
    example: '参数校验失败',
  })
  message!: string;

  @ApiProperty({
    type: () => ValidationErrorDataDto,
    description: '逐字段的错误清单',
  })
  data!: ValidationErrorDataDto;
}
