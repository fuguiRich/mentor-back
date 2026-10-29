import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import {
  buildDocument,
  collectPublicRoutes,
  configureApp,
  HTTP_METHODS,
  hasUserInput,
} from '../src/bootstrap';
import { swaggerCustomize } from '../src/swagger';
import { ERROR_CODE_DESCRIPTIONS } from '../src/common/constants/error-code';

interface OperationObject {
  parameters?: unknown[];
  requestBody?: unknown;
  responses: Record<string, unknown>;
}

function getOperations(
  paths: Record<string, Record<string, unknown>>,
): Array<{ key: string; operation: OperationObject }> {
  const result: Array<{ key: string; operation: OperationObject }> = [];
  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method] as OperationObject | undefined;
      if (op !== undefined) {
        result.push({ key: `${method.toUpperCase()} ${path}`, operation: op });
      }
    }
  }
  return result;
}

/** 从 responses 里的 $ref / oneOf 收集所有响应方向的 schema 名 */
function collectResponseSchemaNames(
  paths: Record<string, Record<string, unknown>>,
): Set<string> {
  const names = new Set<string>();
  for (const pathItem of Object.values(paths)) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method] as OperationObject | undefined;
      if (!op) continue;
      for (const res of Object.values(op.responses)) {
        // 三层才是对的形状：res → content（按 media type）→ { schema }。
        // 写成两层会让 `Object.values(content)` 推成 `unknown[]`，`media.schema` 报
        // TS18046。tsconfig.build 不含 test/，这条一直没被 `tsc --noEmit -p tsconfig.build.json`
        // 抓到——**类型门禁必须跑 tsconfig.json**，否则 test/ 是盲区。
        const content = (
          res as {
            content?: Record<string, { schema?: Record<string, unknown> }>;
          }
        ).content;
        if (!content) continue;
        for (const media of Object.values(content)) {
          const schema = media.schema;
          if (!schema) continue;
          if (schema['$ref']) {
            names.add(
              (schema['$ref'] as string).replace('#/components/schemas/', ''),
            );
          }
          if (Array.isArray(schema['oneOf'])) {
            for (const s of schema['oneOf'] as Array<Record<string, unknown>>) {
              if (s['$ref']) {
                names.add(
                  (s['$ref'] as string).replace('#/components/schemas/', ''),
                );
              }
            }
          }
          if (Array.isArray(schema['allOf'])) {
            for (const s of schema['allOf'] as Array<Record<string, unknown>>) {
              if (s['$ref']) {
                names.add(
                  (s['$ref'] as string).replace('#/components/schemas/', ''),
                );
              }
            }
          }
        }
      }
    }
  }
  return names;
}

/** 从一个 schema 出发，沿 $ref / allOf / oneOf / anyOf / items / properties 展开所有可达的 property 名 */
function collectPropertyNames(
  schema: Record<string, unknown>,
  allSchemas: Record<string, Record<string, unknown>>,
  visited: Set<string> = new Set(),
): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();

  if (schema['$ref']) {
    const refName = (schema['$ref'] as string).replace(
      '#/components/schemas/',
      '',
    );
    if (visited.has(refName)) return result;
    visited.add(refName);
    const target = allSchemas[refName];
    if (target) {
      for (const [k, v] of collectPropertyNames(target, allSchemas, visited)) {
        result.set(k, v);
      }
    }
    return result;
  }

  for (const combinator of ['allOf', 'oneOf', 'anyOf'] as const) {
    const arr = schema[combinator] as
      Array<Record<string, unknown>> | undefined;
    if (arr) {
      for (const sub of arr) {
        for (const [k, v] of collectPropertyNames(sub, allSchemas, visited)) {
          result.set(k, v);
        }
      }
    }
  }

  const props = schema['properties'] as
    Record<string, Record<string, unknown>> | undefined;
  if (props) {
    for (const [name, propSchema] of Object.entries(props)) {
      result.set(name, propSchema);
      // 递归展开嵌套 object 的 properties / $ref / items / 组合子包装
      if (
        propSchema['properties'] ||
        propSchema['$ref'] ||
        propSchema['items'] ||
        propSchema['allOf'] ||
        propSchema['oneOf'] ||
        propSchema['anyOf']
      ) {
        for (const [k, v] of collectPropertyNames(
          propSchema,
          allSchemas,
          visited,
        )) {
          result.set(k, v);
        }
      }
    }
  }

  const items = schema['items'] as Record<string, unknown> | undefined;
  if (items) {
    for (const [k, v] of collectPropertyNames(items, allSchemas, visited)) {
      result.set(k, v);
    }
  }

  return result;
}

/**
 * 通用后台那一面的**路由清单**：路径 → 它上面该有的方法（小写，与 OpenAPI
 * Path Item 的键一致）。
 *
 * 这份清单判「一条都不能少」，**不判「一条都不能多」**。理由：这份测试随
 * 源码一并归入生成出来的项目，而项目的业务路由（导师那套业务，以及使用方
 * 以后加的）本来就会长出来——把总路径数钉死等于「一加业务接口就红」，那是噪音，不是
 * 回归网。删掉一条这里会点名到具体的 `METHOD /path`；多出来的路径不在判据
 * 里，那是项目自己该长的东西。
 *
 * 35 条路径 / 49 条方法这个数写在下面的断言里：改这张表的人会看见它跟着变。
 */
const ADMIN_SURFACE: Readonly<Record<string, readonly string[]>> = {
  '/auth/login': ['post'],
  '/auth/logout': ['post'],
  '/auth/password': ['put'],
  '/auth/profile': ['get'],
  '/auth/refresh': ['post'],
  '/auth/sso/authorize': ['get'],
  '/auth/sso/callback': ['get'],
  '/configs': ['get', 'post'],
  '/configs/{id}': ['get', 'put', 'delete'],
  '/depts/tree': ['get'],
  '/depts/{id}': ['get'],
  '/dict-items': ['get', 'post'],
  '/dict-items/{id}': ['put', 'delete'],
  '/dict-types': ['get', 'post'],
  '/dict-types/{id}': ['get', 'put', 'delete'],
  '/files': ['get', 'post'],
  '/files/{id}': ['delete'],
  '/files/{id}/download': ['get'],
  '/files/{id}/preview': ['get'],
  '/health': ['get'],
  '/op-logs': ['get'],
  '/op-logs/{id}': ['get'],
  '/permissions': ['post'],
  '/permissions/tree': ['get'],
  '/permissions/{id}': ['get', 'put', 'delete'],
  '/roles': ['get', 'post'],
  '/roles/{id}': ['get', 'put', 'delete'],
  '/roles/{id}/permissions': ['put'],
  '/roles/{id}/status': ['put'],
  '/users': ['get'],
  '/users/account': ['post'],
  '/users/{id}': ['get'],
  '/users/{id}/password': ['put'],
  '/users/{id}/roles': ['put'],
  '/users/{id}/status': ['put'],
};

describe('OpenAPI 契约 (e2e)', () => {
  let app: INestApplication;
  let document: ReturnType<typeof buildDocument>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app, { swagger: swaggerCustomize });
    await app.init();

    document = buildDocument(app, swaggerCustomize);
  });

  afterAll(async () => {
    await app.close();
  });

  // ── 1. 通用后台那一面：一条路径、一条方法都不能少 ──────────────────
  it('通用后台的 35 条路径 / 49 条方法一条不少（业务路由不在这条判据里）', () => {
    // 先钉清单自身：改 ADMIN_SURFACE 的人会看见这两个数跟着变
    expect(Object.keys(ADMIN_SURFACE)).toHaveLength(35);
    expect(Object.values(ADMIN_SURFACE).flat()).toHaveLength(49);

    const actual = document.paths as Record<string, Record<string, unknown>>;
    const missing: string[] = [];
    for (const [path, methods] of Object.entries(ADMIN_SURFACE)) {
      const item = actual[path];
      if (item === undefined) {
        missing.push(`${path}（整条路径没了）`);
        continue;
      }
      for (const method of methods) {
        if (item[method] === undefined) {
          missing.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  // ── 2. 400 的充要条件（R5）────────────────────────────────────────
  it('有输入的 operation 都有 responses.400', () => {
    const operations = getOperations(
      document.paths as Record<string, Record<string, unknown>>,
    );
    const withInput = operations.filter((o) => hasUserInput(o.operation));
    expect(withInput.length).toBeGreaterThan(0);
    for (const { operation } of withInput) {
      expect(operation.responses['400']).toBeDefined();
    }
  });

  it('注入的 400（$ref 型）指向 ValidationErrorResponseDto', () => {
    const operations = getOperations(
      document.paths as Record<string, Record<string, unknown>>,
    );
    for (const { operation } of operations) {
      const res400 = operation.responses['400'] as
        | {
            content?: Record<string, { schema?: Record<string, unknown> }>;
          }
        | undefined;
      if (!res400) continue;
      const schema = res400.content?.['application/json']?.schema;
      if (schema?.$ref !== undefined) {
        expect(schema.$ref).toBe(
          '#/components/schemas/ValidationErrorResponseDto',
        );
      }
    }
  });

  it('没有输入的 operation 都没有 responses.400', () => {
    const operations = getOperations(
      document.paths as Record<string, Record<string, unknown>>,
    );
    const withoutInput = operations.filter((o) => !hasUserInput(o.operation));
    for (const { operation } of withoutInput) {
      expect(operation.responses['400']).toBeUndefined();
    }
  });

  // ── 3. 没输入的接口：通用后台这四条必须还在 ─────────────────────────
  // 它们是上一条「没输入 ⇒ 没有 400」的**非空见证**：一条都不剩，上一条就
  // 空转通过。判「包含」不判「恰好」——项目自己加无输入接口是常事；但这四条
  // 若变成了「有输入」，那是 400 语义真的变了，要来改这张清单。
  it('没输入的接口含 GET /health、GET /auth/profile、GET /auth/sso/authorize、GET /permissions/tree', () => {
    const operations = getOperations(
      document.paths as Record<string, Record<string, unknown>>,
    );
    const withoutInput = operations
      .filter((o) => !hasUserInput(o.operation))
      .map((o) => o.key);
    expect(withoutInput.length).toBeGreaterThan(0);
    expect(withoutInput.sort()).toEqual(
      expect.arrayContaining([
        'GET /auth/profile',
        'GET /auth/sso/authorize',
        'GET /health',
        'GET /permissions/tree',
      ]),
    );
  });

  // ── 4. 每个 operation 都有响应注解（DOC-04/07）────────────────────
  it('每个 operation 的 responses 非空且至少有一个非 400 的键', () => {
    const operations = getOperations(
      document.paths as Record<string, Record<string, unknown>>,
    );
    for (const { operation } of operations) {
      const keys = Object.keys(operation.responses);
      expect(keys.length).toBeGreaterThan(0);
      const non400 = keys.filter((k) => k !== '400');
      expect(non400.length).toBeGreaterThan(0);
    }
  });

  // ── 5. X | null 的 type 没退化成 object（DOC-06）──────────────────
  it('components.schemas 中 type=object 的 property 必须有结构或显式声明自由形态', () => {
    const schemas = document.components?.schemas as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemas).toBeDefined();
    const schemaNames = Object.keys(schemas);
    expect(schemaNames.length).toBeGreaterThan(0);

    const problems = new Set<string>();

    function walkSchema(name: string, schema: Record<string, unknown>): void {
      if (schema['type'] === 'object') {
        // 两种「可以」：写出了结构，或者显式声明了自由形态
        // （additionalProperties——OpLogResponseDto.before/after 这类形状由写入方
        // 决定的 JSON 就是它）。DOC-06 要抓的是第三种：`X | null` 忘写 type，
        // 被 Swagger 推成一个既没有 properties 也没有 additionalProperties 的
        // 空 object——那不是「自由形态」，是「没声明」。
        const hasStructure =
          schema['properties'] !== undefined ||
          schema['$ref'] !== undefined ||
          schema['allOf'] !== undefined ||
          schema['oneOf'] !== undefined ||
          schema['anyOf'] !== undefined ||
          schema['additionalProperties'] !== undefined;
        if (!hasStructure) {
          problems.add(name);
        }
      }
      const props = schema['properties'] as
        Record<string, Record<string, unknown>> | undefined;
      if (props) {
        for (const [propName, propSchema] of Object.entries(props)) {
          walkSchema(`${name}.${propName}`, propSchema);
        }
      }
      const items = schema['items'] as Record<string, unknown> | undefined;
      if (items) {
        walkSchema(`${name}[]`, items);
      }
    }

    for (const [name, schema] of Object.entries(schemas)) {
      walkSchema(name, schema);
    }

    expect([...problems]).toEqual([]);
  });

  // ── 5b. 没有 3xx 响应（R11）──────────────────────────────────────
  it('没有任何 operation 声明 3xx 响应（R11：SSO 回调走 200 + JSON 双令牌，不走 302）', () => {
    const operations = getOperations(
      document.paths as Record<string, Record<string, unknown>>,
    );
    for (const { key, operation } of operations) {
      for (const code of Object.keys(operation.responses)) {
        const is3xx = /^3\d\d$/i.test(code) || code.toLowerCase() === '3xx';
        if (is3xx) {
          throw new Error(
            `R11 违规：${key} 声明了 3xx 响应（${code}）。` +
              'SSO 回调应返回 200 + JSON 双令牌，不走 302 重定向——重定向目标与令牌携带方式尚未裁决，302 是猜测。',
          );
        }
      }
    }
  });

  // ── 5c. 响应 schema 无 password（RES-04）──────────────────────────
  it('响应 schema 中不包含 password 属性（RES-04：永远不输出 password）', () => {
    const paths = document.paths as Record<string, Record<string, unknown>>;
    const allSchemas = document.components?.schemas as Record<
      string,
      Record<string, unknown>
    >;
    const responseNames = collectResponseSchemaNames(paths);
    expect(responseNames.size).toBeGreaterThan(0);

    const problems: string[] = [];
    for (const name of responseNames) {
      const schema = allSchemas[name];
      if (!schema) continue;
      const props = collectPropertyNames(schema, allSchemas);
      for (const [propName] of props) {
        if (propName === 'password') {
          problems.push(name);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  // ── 5d. id / *Id / *Ids 属性类型符合 BIGINT 序列化约定 ──────────────
  it('所有 id / *Id / *Ids 属性的类型符合 BIGINT 序列化约定', () => {
    const allSchemas = document.components?.schemas as Record<
      string,
      Record<string, unknown>
    >;
    const problems: string[] = [];

    function checkIdProps(name: string, schema: Record<string, unknown>): void {
      const props = schema['properties'] as
        Record<string, Record<string, unknown>> | undefined;
      if (props) {
        for (const [propName, propSchema] of Object.entries(props)) {
          if (
            propName === 'id' ||
            propName.endsWith('Id') ||
            propName.endsWith('Ids')
          ) {
            if (propName.endsWith('Ids')) {
              // 复数：BIGINT 外部一律字符串，这条约定对集合元素同样成立
              const items = propSchema['items'] as
                Record<string, unknown> | undefined;
              if (
                propSchema['type'] !== 'array' ||
                items?.['type'] !== 'string'
              ) {
                problems.push(
                  `${name}.${propName} 元素 type=${String(items?.['type'])}（须为 string 数组）`,
                );
              }
            } else if (propSchema['type'] !== 'string') {
              problems.push(
                `${name}.${propName} type=${String(propSchema['type'])}`,
              );
            }
          }
          checkIdProps(`${name}.${propName}`, propSchema);
        }
      }
      const items = schema['items'] as Record<string, unknown> | undefined;
      if (items) {
        checkIdProps(`${name}[]`, items);
      }
    }

    for (const [name, schema] of Object.entries(allSchemas)) {
      checkIdProps(name, schema);
    }

    expect(problems).toEqual([]);
  });

  // ── 6. docs:gen 与在线文档同源 ─────────────────────────────────────
  // 两边都从 src/swagger.ts 的 swaggerCustomize 出发，比出来的差才只会是
  // 「改了 Controller 忘了重跑 docs:gen」，而不是「一边带定制一边不带」。
  it('buildDocument(app, swaggerCustomize) 的结果与 docs/openapi.json 完全一致', () => {
    const generated = JSON.stringify(document);
    const filePath = join(process.cwd(), 'docs', 'openapi.json');
    const fileContent = readFileSync(filePath, 'utf8');
    const fileDoc = JSON.stringify(JSON.parse(fileContent));
    expect(generated).toBe(fileDoc);
  });

  // ── 7. 错误码表完整 ───────────────────────────────────────────────
  // 项目会往表里**追加**业务错误码（30000 起，走 SwaggerCustomize.extraErrorCodes），
  // 所以判「本包那张表一条不少」，不判「恰好这么多」——判恰好等于「一加业务
  // 错误码就红」，那正是定制这个口子存在的理由。
  it('components.schemas 含 ValidationErrorResponseDto，ERROR_CODE_DESCRIPTIONS 逐条都在错误码表里', () => {
    const schemas = document.components?.schemas as Record<string, unknown>;
    expect(schemas['ValidationErrorResponseDto']).toBeDefined();

    const description = document.info?.description ?? '';
    const errorCodeLines = description
      .split('\n')
      .filter((line) => /^- \d+ /.test(line));
    const missing = Object.keys(ERROR_CODE_DESCRIPTIONS).filter(
      (code) => !errorCodeLines.some((line) => line.startsWith(`- ${code} `)),
    );
    expect(missing).toEqual([]);
    expect(errorCodeLines.length).toBeGreaterThanOrEqual(
      Object.keys(ERROR_CODE_DESCRIPTIONS).length,
    );
  });

  // ── 8. 免登录面钉死（@Public 集合）────────────────────────────────
  // 这条**故意**判「恰好」，与第 1 条的「一条不少」相反：免登录面是安全边界，
  // 多出一条来必须有人看一眼。项目要加公开路由就来改这张清单——那是摩擦，
  // 也是它唯一的作用。
  it('免登录路由恰好是 5 条（@Public 集合钉死）', () => {
    expect(collectPublicRoutes(app).sort()).toEqual([
      'GET /auth/sso/authorize',
      'GET /auth/sso/callback',
      'GET /health',
      'POST /auth/login',
      'POST /auth/refresh',
    ]);
  });

  // ── 9. 鉴权声明落进文档 ───────────────────────────────────────────
  // 只在 components 里登记 securitySchemes 而没有任何 operation 引用它，
  // 症状是 Swagger 上每条接口都没有锁图标、点了 Authorize 也不发 token——
  // 看上去「接口全是公开的」，实际每个请求都 401。这条钉的就是那个缺口。
  it('顶层声明 bearer，@Public 的那几条显式 security: []', () => {
    // 顶层默认就是「所有操作都要 bearer」。没有它，59 条业务接口在文档里
    // 全是「不需要鉴权」——Swagger 不显示锁、Authorize 也不发 token。
    expect(document.security).toEqual([{ bearer: [] }]);

    const publicRoutes = new Set(
      collectPublicRoutes(app).map((route) => route.toLowerCase()),
    );
    const methods: readonly string[] = HTTP_METHODS;

    const notExplicitlyPublic: string[] = [];
    const publicButRequiresAuth: string[] = [];

    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(
        item as Record<string, unknown>,
      )) {
        if (!methods.includes(method)) {
          continue;
        }
        const op = operation as { security?: unknown[] };
        const label = `${method.toUpperCase()} ${path}`;
        const declaresEmpty =
          op.security !== undefined && op.security.length === 0;
        const isPublic = publicRoutes.has(label.toLowerCase());

        if (isPublic && !declaresEmpty) {
          // 公开面必须**显式**写空数组：靠「没写 = 继承顶层默认」会被默认吞掉
          notExplicitlyPublic.push(label);
        }
        if (!isPublic && declaresEmpty) {
          publicButRequiresAuth.push(label);
        }
      }
    }

    expect(notExplicitlyPublic).toEqual([]);
    expect(publicButRequiresAuth).toEqual([]);
  });
});
