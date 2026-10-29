import { SetMetadata } from '@nestjs/common';

export const NO_ENVELOPE_KEY = 'noEnvelope';

/**
 * 跳过统一响应外壳。仅用于返回二进制流或 204 的接口——
 * 把 StreamableFile 套进 JSON 会让文件下载直接坏掉。
 */
export const NoEnvelope = () => SetMetadata(NO_ENVELOPE_KEY, true);
