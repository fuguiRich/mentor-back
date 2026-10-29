import { Module } from '@nestjs/common';
import { DeptController } from './dept.controller';
import { DeptRepository } from './dept.repository';
import { DeptService } from './dept.service';

@Module({
  controllers: [DeptController],
  providers: [DeptService, DeptRepository],
  exports: [DeptService, DeptRepository],
})
export class DeptModule {}
