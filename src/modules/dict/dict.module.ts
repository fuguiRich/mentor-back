import { Module } from '@nestjs/common';
import { DictController } from './dict.controller';
import { DictRepository } from './dict.repository';
import { DictService } from './dict.service';

@Module({
  controllers: [DictController],
  providers: [DictService, DictRepository],
  exports: [DictService],
})
export class DictModule {}
