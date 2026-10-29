import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { configureApp } from './bootstrap';
import { AppModule } from './app.module';
import { swaggerCustomize } from './swagger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // configureApp 一次配齐：请求上下文、校验管道、响应外壳、异常收口、
  // helmet、CORS、Swagger。少调一样，就会出现「响应形状和别的接口不一样」
  // 这类要到联调时才发现的裂缝。
  configureApp(app, { swagger: swaggerCustomize });

  await app.listen(app.get(ConfigService).getOrThrow<number>('port'));
}

void bootstrap();
