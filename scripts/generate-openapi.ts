import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { buildDocument, configureApp } from '../src/bootstrap';
import { AppModule } from '../src/app.module';
import { swaggerCustomize } from '../src/swagger';

/** Path Item 里算「一个操作」的 key。OpenAPI 只认这几个 */
const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'patch',
  'head',
  'options',
  'trace',
] as const;

// 与运行时同一份环境装载；docs:gen 不该是「另一条配置路径」
config();

/**
 * 生成 docs/openapi.json —— **一份契约**：通用后台的 36 个路径 + 本项目的业务接口。
 *
 * 为什么不手写这份文件：手写的契约与真实路由漂移只是时间问题，而漂了之后
 * 只有前端在联调时才会发现。这里是从真实应用里抽出来的，改了 Controller
 * 重跑一次就对上。
 *
 * 用法：`pnpm docs:gen`（JWT_SECRET 走命令行一次性传入更好，别落盘）。
 */
async function main(): Promise<void> {
  // `logger: ['error']` 而不是 `logger: false`：Nest 在异常区里捕获启动期错误
  // 后是**用 logger 打印再 process.exit(1)** 的。整份关掉，失败就变成「静默
  // exit 1」——一条 JWT_SECRET 长度不足就是这样查了十轮才挖到的。只留 error
  // 级：成功时照样一行都不多打。
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  configureApp(app, { swagger: swaggerCustomize });
  await app.init();

  const document = buildDocument(app, swaggerCustomize);
  const outPath = resolve(__dirname, '..', 'docs', 'openapi.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  const paths = Object.keys(document.paths);
  const operations = paths.reduce((sum, path) => {
    const item = document.paths[path] as Record<string, unknown>;
    return sum + HTTP_METHODS.filter((m) => item[m] !== undefined).length;
  }, 0);

  console.log(`已写入 ${outPath}`);
  console.log(`接口契约：${paths.length} 路径 / ${operations} 操作`);

  await app.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
