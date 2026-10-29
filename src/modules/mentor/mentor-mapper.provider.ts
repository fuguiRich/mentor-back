import { Injectable } from '@nestjs/common';
import type { MentorProfile } from '@prisma/client';
import type { MentorProfileResponseDto } from './dto/mentor-profile.dto';
import { toMentorProfileResponse } from './mentor.mapper';

/**
 * `MentorModule` 对外的映射面（LAYER-06）：mentor-application 要复用
 * `toMentorProfileResponse`（R68 键名翻译只此一张表），但跨模块不能直接
 * import 对方内部的 mapper 实现——规范反例恰是
 * `import { toUserResponse } from '../user/user.mapper'`。这里把 mapper
 * 导出成 provider、由消费方构造注入；mapper 纯函数的签名与实现一字不动。
 */
@Injectable()
export class MentorMapperProvider {
  toMentorProfileResponse(
    entity: MentorProfile,
    personType: string,
  ): MentorProfileResponseDto {
    return toMentorProfileResponse(entity, personType);
  }
}
