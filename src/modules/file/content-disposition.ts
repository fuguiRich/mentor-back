/**
 * 构造 Content-Disposition。原始文件名可能含非 ASCII 与引号，
 * 两个坑各占一个字段：
 *
 * - `filename="…"` 给老客户端，必须去掉引号 / 反斜杠 / 控制字符与非 ASCII，
 *   否则一个文件名就能把响应头断开，续上一节伪造别的头；
 * - `filename*=UTF-8''…` 是 RFC 5987，`encodeURIComponent` 之后还要把
 *   `'*()` 也转义掉（它们在 attr-char 里不合法，但 encodeURIComponent
 *   当成未保留字符放行）。`!` 不在其列——它在 attr-char 里合法。
 *
 * 两个都写：老客户端读前者，现代客户端优先后者。
 */
export function contentDisposition(
  type: 'inline' | 'attachment',
  filename: string,
): string {
  // 逐字符过一遍：只保留可打印 ASCII，其余（控制字符、引号、反斜杠、
  // 中文、emoji……）一律换成 `_`。语义是「这只是个兜底文件名」，
  // 真实名字走 filename*。
  let ascii = '';
  for (const char of filename) {
    const code = char.codePointAt(0) ?? 0;
    const printableAscii = code >= 0x20 && code <= 0x7e;
    ascii += printableAscii && char !== '"' && char !== '\\' ? char : '_';
  }
  ascii = ascii.trim() === '' ? 'file' : ascii;

  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
