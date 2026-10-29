/**
 * 取 `Authorization: Bearer xxx` 里的令牌。
 * 大小写不敏感（RFC 7235 的 scheme 本就是大小写不敏感），
 * 但**不**接受 `Basic` / 裸令牌 / 多个空格以外的写法——松一点的解析
 * 只会让"前端把令牌拼错"变成"服务端行为诡异"。
 */
export function extractBearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string') {
    return null;
  }

  const match = /^Bearer[ ]+(?<token>\S+)$/i.exec(header.trim());
  return match?.groups?.token ?? null;
}
