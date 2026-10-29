import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import type { AppConfig } from '../../config/configuration';
import { DEFAULT_FILE_MAX_BYTES, FILE_MAX_COUNT } from './file.constants';
import { FileController } from './file.controller';
import { FileRepository } from './file.repository';
import { FileService } from './file.service';
import { OpLogModule } from '../oplog/oplog.module';

/**
 * multer 的限额配在这里而不是写死在拦截器上：`FileInterceptor` 装饰器在类定义时
 * 就求值了，拿不到 DI 里的配置。`@FileInterceptor` / `@FilesInterceptor` 会自动
 * 合并这里注册的 MULTER_MODULE_OPTIONS（见 platform-express 的 file.interceptor.js）。
 *
 * 不显式配 storage：multer 的默认就是 MemoryStorage。内存缓冲让「读文件头判魔数」
 * 与「算 sha256」各是一次零拷贝，比先写临时盘再流式读回来简单得多。
 * 代价是单请求内存占用 ≈ 上传体积 × 文件数，由 FILE_MAX_BYTES 与 FILE_MAX_COUNT 兜住。
 * 要接大文件（>50MB 级）请改成「写临时盘 → 流式算哈希 → rename」，不是调大上限。
 */
@Module({
  imports: [
    OpLogModule,
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        limits: {
          fileSize:
            config.get('file.maxBytes', { infer: true }) ??
            DEFAULT_FILE_MAX_BYTES,
          files: FILE_MAX_COUNT,
        },
        // busboy 默认按 latin1 解 multipart 头里的 filename（RFC 2616 时代的
        // 兼容垫）。浏览器实际发的是 UTF-8 字节，于是「成绩单.png」到了
        // originalname 就成了「æç»©å.png」——中文文件名是本系统最常见的输入，
        // 存一列谁也看不懂的名字等于这一列作废。defParamCharset 只在客户端
        // **没有**给 `filename*` 时生效，走 RFC 5987 的请求不受影响。
        defParamCharset: 'utf8',
      }),
    }),
  ],
  controllers: [FileController],
  providers: [FileService, FileRepository],
  exports: [FileService],
})
export class FileModule {}
