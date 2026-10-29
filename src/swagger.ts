import type { SwaggerCustomize } from './bootstrap';

/**
 * 本项目对 /api-docs 的定制：标题、项目自述、业务错误码。
 *
 * **main.ts 与 scripts/generate-openapi.ts 共用这一份**。两处各写一遍，
 * 「在线文档」与「docs/openapi.json 契约快照」迟早会不一致——而那份快照
 * 是要给前端做 codegen 的，漂一点就是一批错的类型。
 *
 * 响应外壳那段标准说明由包内写死，不给覆盖：那是全站契约，
 * 每个项目各自叙述一遍，三个项目之后就再也不一致了。
 */
export const swaggerCustomize: SwaggerCustomize = {
  title: 'mentor-back API',
  extraDescription:
    '业务接口与通用后台共用同一份响应外壳；业务错误码从 30000 起，' +
    '通用后台已占用 10000-28999。',
  extraErrorCodes: {},
};
