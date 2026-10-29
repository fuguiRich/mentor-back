import { Module } from '@nestjs/common';
import { DataScopeModule } from '../data-scope/data-scope.module';
import { FileModule } from '../file/file.module';
import { UserModule } from '../user/user.module';
import { MentorMaterialController } from './mentor-material.controller';
import { MentorMaterialRepository } from './mentor-material.repository';
import { MentorMaterialService } from './mentor-material.service';

/**
 * 导师佐证材料（Task 16+17）。
 *
 * `FileService` 走**模块导出**拿（LAYER-06）：`FileModule` 已 `exports:
 * [FileService]`，这里 `imports: [FileModule]` 然后构造注入——**不许**
 * `import '../file/content-disposition'` 伸手进别个模块的内部文件。
 * `assertOwnedBy` / `serve` 都是 FileService 的公开面（R79）。
 *
 * 不加 `OpLogModule`：本任务不写操作日志（R76/R77 只落在审核流上）。
 */
@Module({
  imports: [UserModule, DataScopeModule, FileModule],
  controllers: [MentorMaterialController],
  providers: [MentorMaterialService, MentorMaterialRepository],
  exports: [MentorMaterialService],
})
export class MentorMaterialModule {}
