/**
 * 失败响应示例的外壳帮助函数（规范 DOC-07 / DOC-13）。
 *
 * DOC-07 要求失败示例**必须含完整外壳** `{ code, message, data: null }`——
 * 少了 `data` 的示例会让前端漏掉兜底分支的字段。DOC-13 禁止把这个外壳
 * 在每个接口旁边重排一遍：样板只写一次，每个接口只写一行调用。
 *
 * 两者并不冲突——用这个函数即可同时满足。
 */
export const errExample = (
  code: number,
  message: string,
): { code: number; message: string; data: null } => ({
  code,
  message,
  data: null,
});

/**
 * 同一接口有多个失败原因并列时（OpenAPI 的 `oneOf`），每一项也只写一次调用，
 * 不重排外壳（DOC-13）。
 *
 * 返回的是**外壳数组**，调用点再包一层 `{ example }` 交给 `oneOf`——那一层是
 * OpenAPI 的形状，不是响应外壳，不该混进这里。
 */
export const errExamples = (
  ...pairs: Array<[number, string]>
): Array<{ code: number; message: string; data: null }> =>
  pairs.map(([code, message]) => errExample(code, message));
