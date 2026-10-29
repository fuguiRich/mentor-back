import { ApiProperty } from '@nestjs/swagger';
import { PageResponseDto } from '../../../common/dto/page-response.dto';
import { UserResponseDto } from './user-response.dto';

export class UserPageResponseDto extends PageResponseDto<UserResponseDto> {
  // 重写 list 的注解：Swagger 推断不出泛型元素类型（spec 第 6 节 ⑤）。
  // `declare` 是编译要求：target ES2023 下 useDefineForClassFields 为 true，
  // 子类字段重声明会触发 TS2612（定义语义覆盖基类字段）；declare 表示
  // 「只覆盖类型、不产出字段」，装饰器照常挂到原型元数据上。
  @ApiProperty({
    type: () => [UserResponseDto],
    description: '当前页的用户列表',
  })
  declare list: UserResponseDto[];
}
