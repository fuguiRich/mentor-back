import { Module } from '@nestjs/common';
import { SysConfigModule } from '../config/config.module';
import { DataScopeModule } from '../data-scope/data-scope.module';
import { UserModule } from '../user/user.module';
import { AssessmentController } from './assessment.controller';
import { AssessmentRepository } from './assessment.repository';
import { AssessmentService } from './assessment.service';

/**
 * 考核（P3 Task 37–42）。指标聚合在 `assessment.metrics.ts`（纯函数）+
 * `AssessmentRepository`（只读聚合）。
 *
 * 依赖 `SysConfigModule`（权重与目标值）、`DataScopeModule`（学院只看本院）、
 * `UserModule`（后续任务的身份链）。写只有 `assessment` / `assessment_appeal`
 * 两张表；评价 / 指导记录 / 成果都只读。
 */
@Module({
  imports: [SysConfigModule, DataScopeModule, UserModule],
  controllers: [AssessmentController],
  providers: [AssessmentService, AssessmentRepository],
  exports: [AssessmentService],
})
export class AssessmentModule {}
