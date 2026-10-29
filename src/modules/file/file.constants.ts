/**
 * 允许上传的文件类型白名单。**只有带可靠魔数的类型才在表里**——
 * 这不是疏忽：txt / csv / docx 这类「按扩展名才认得出来」的类型，
 * 服务端根本没有客观依据说「这份字节确实是它」，进了白名单就等于
 * 把「我信了扩展名」写成了「我验过了」。要加类型，先给出它的魔数。
 *
 * 刻意排除 svg：svg 是 XML，能内嵌 <script>。同源访问下它是一个
 * 可执行页面，不是一张图片。要支持矢量图请转成 png 或走受控的渲染服务。
 */
export interface AllowedFileType {
  /** 允许的扩展名（小写、不含点）。第一个是落库的规范形式 */
  exts: readonly [string, ...string[]];
  mime: string;
  /** 文件头是否属于本类型。`head` 至少 16 字节，不足时按实际长度判断 */
  matches(head: Buffer): boolean;
}

function startsWith(head: Buffer, signature: readonly number[]): boolean {
  return (
    head.length >= signature.length &&
    signature.every((byte, index) => head[index] === byte)
  );
}

export const ALLOWED_FILE_TYPES: readonly AllowedFileType[] = [
  {
    exts: ['png'],
    mime: 'image/png',
    matches: (head) =>
      startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    exts: ['jpg', 'jpeg'],
    mime: 'image/jpeg',
    matches: (head) => startsWith(head, [0xff, 0xd8, 0xff]),
  },
  {
    exts: ['gif'],
    mime: 'image/gif',
    // GIF87a / GIF89a 的共同前缀
    matches: (head) => startsWith(head, [0x47, 0x49, 0x46, 0x38]),
  },
  {
    exts: ['webp'],
    mime: 'image/webp',
    matches: (head) =>
      startsWith(head, [0x52, 0x49, 0x46, 0x46]) &&
      startsWith(head.subarray(8), [0x57, 0x45, 0x42, 0x50]),
  },
  {
    exts: ['bmp'],
    mime: 'image/bmp',
    matches: (head) => startsWith(head, [0x42, 0x4d]),
  },
  {
    exts: ['pdf'],
    mime: 'application/pdf',
    // %PDF- …… 允许前面有少量空白是过度宽容，直接锚定在字节 0
    matches: (head) => startsWith(head, [0x25, 0x50, 0x44, 0x46]),
  },
];

export function findTypeByExt(ext: string): AllowedFileType | undefined {
  const normalized = ext.toLowerCase();
  return ALLOWED_FILE_TYPES.find((type) => type.exts.includes(normalized));
}

export function detectTypeByMagic(head: Buffer): AllowedFileType | undefined {
  return ALLOWED_FILE_TYPES.find((type) => type.matches(head));
}

/** 魔数判定只需要看文件头；16 字节覆盖本表所有签名 */
export const MAGIC_HEAD_BYTES = 16;

export const DEFAULT_FILE_ROOT = '.uploads';
export const DEFAULT_FILE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * 一次请求最多收几个文件。不是可配项——它是「一次提交」的语义边界，
 * 调成 1000 就成了一个能一次灌满内存的入口（同 LOGIN_MAX_ATTEMPTS）。
 * multer 侧的硬上限取同一个数，超出由上传错误拦截器翻译成 FILE_COUNT_EXCEEDED。
 */
export const FILE_MAX_COUNT = 10;
