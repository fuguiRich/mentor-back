import { Module } from '@nestjs/common';
import { MentorModule } from '../mentor/mentor.module';
import { MentorSearchController } from './mentor-search.controller';
import { MentorSearchMapper } from './mentor-search.mapper';
import { MentorSearchRepository } from './mentor-search.repository';
import { MentorSearchService } from './mentor-search.service';

/**
 * 导师检索（Task 22）。
 *
 * 依赖 `MentorModule` 只为一件事：`MentorMapperProvider`——`mentorType` 的推导
 * 与 `researchFields` 的 JSON 兜底读在它那里（MentorModule 导出的映射面，
 * LAYER-06）。跨模块不直接 import `mentor.mapper`。
 *
 * `MentorProfile` / `SyncPerson` / `SyncOrgUnit` 的**只读**在
 * `MentorSearchRepository` 里（同 mentor-slot / mentor-material 的口径）；
 * 本模块没有任何写路径。
 */
@Module({
  imports: [MentorModule],
  controllers: [MentorSearchController],
  providers: [MentorSearchService, MentorSearchRepository, MentorSearchMapper],
})
export class MentorSearchModule {}
