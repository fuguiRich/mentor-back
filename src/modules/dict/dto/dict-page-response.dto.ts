import { ApiProperty } from '@nestjs/swagger';
import { PageResponseDto } from '../../../common/dto/page-response.dto';
import { DictItemResponseDto } from './dict-item-response.dto';
import { DictTypeResponseDto } from './dict-type-response.dto';

export class DictTypePageResponseDto extends PageResponseDto<DictTypeResponseDto> {
  // 重写 list 的注解：Swagger 推断不出泛型元素类型（spec 第 6 节 ⑤）。
  // `declare` 是编译要求：target ES2023 下 useDefineForClassFields 为 true
  // （同 role-page-response.dto.ts）。
  @ApiProperty({
    type: () => [DictTypeResponseDto],
    description: '当前页的字典类型列表',
  })
  declare list: DictTypeResponseDto[];
}

export class DictItemPageResponseDto extends PageResponseDto<DictItemResponseDto> {
  @ApiProperty({
    type: () => [DictItemResponseDto],
    description: '当前页的字典项列表',
  })
  declare list: DictItemResponseDto[];
}
