import { randomUUID } from 'node:crypto';
import {
  type INestApplication,
  Logger,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { DiscoveryService, ModulesContainer, Reflector } from '@nestjs/core';
import {
  DocumentBuilder,
  type OpenAPIObject,
  type PathsObject,
  SwaggerModule,
} from '@nestjs/swagger';
import helmet from 'helmet';
import { ConfigService } from '@nestjs/config';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { ERROR_CODE_DESCRIPTIONS } from './common/constants/error-code';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import {
  FieldErrorDto,
  ValidationErrorDataDto,
} from './common/dto/field-error.dto';
import { ValidationErrorResponseDto } from './common/dto/error-response.dto';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { DataScopeInterceptor } from './common/interceptors/data-scope.interceptor';
import { validationExceptionFactory } from './common/pipes/validation-exception.factory';
import { requestContext } from './common/context/request-context';
import { IS_PUBLIC_KEY } from './common/decorators/public.decorator';

/**
 * 业务项目对 Swagger 文档的**可选**定制。
 *
 * 为什么留这个口子：种子生成出来的项目有自己的名字、自己的业务错误码
 * （30000 起）。标题、版本、错误码表都该由**项目**给，不该退回源码里改字符串——
 * 那会让 `docs/openapi.json` 的契约快照跟着项目名字一起抖。
 *
 * 默认值与不传时逐字节一致：`docs/openapi.json` 的契约快照不受影响。
 */
export interface SwaggerCustomize {
  /** 文档标题。默认「通用后台管理接口」 */
  title?: string;
  /** 文档版本。默认 '1.0' */
  version?: string;
  /**
   * 追加在标准外壳说明之后、错误码表之前的项目自述。
   *
   * **追加而不是替换**：响应外壳那段是全站契约，项目换名字不代表它可以不写。
   * 要改契约本身，去改本包，不要在每个项目里各自叙述一遍。
   */
  extraDescription?: string;
  /**
   * 业务错误码说明，追加到错误码表末尾。键是错误码数字。
   *
   * 本包已占用 10000-28999（`ERROR_CODE_SEGMENTS`），业务从 **30000** 起。
   * 为什么不能靠 `ErrorCode` 枚举扩展：枚举是本包编译期产物，使用方加不进去；
   * 这里是文档层的补充，运行时抛错照旧用 `new BusinessException(code, ...)`。
   */
  extraErrorCodes?: Readonly<Record<number, string>>;
}

const DEFAULT_SWAGGER_TITLE = '通用后台管理接口';
const DEFAULT_SWAGGER_VERSION = '1.0';

/**
 * 标准外壳说明。**这是全站契约**，逐字写死在这里，不给业务项目覆盖——
 * 每个项目各自叙述一遍响应形状，三个项目之后就再也不一致了。
 *
 * 与 {@link ERROR_TABLE_HEADER} 拆成两段：`extraDescription` 要插在**叙事**与
 * **错误码附录**之间。合成一段的话，项目自述会被顶到「错误码一览」标题之后、
 * 表格之前，读起来像表格的引言——那正是不想要的。
 */
const ENVELOPE_DESCRIPTION =
  '统一响应外壳：成功 `{ code: 0, message: "ok", data, traceId }`；' +
  '失败 `{ code: <业务错误码>, message: <文案>, traceId }`。' +
  '`data` 的形状看**失败的来源**，不看错误码：' +
  'class-validator 管道校验失败（10001）为 `{ fields: [{ field, message }] }`（逐字段清单）；' +
  '业务层抛出的失败——**包括业务层自己的 10001 参数错误**——`data` 为 `null`。' +
  'HTTP 状态码保留传输语义。\n\n';

const ERROR_TABLE_HEADER = '错误码一览（由 `ErrorCode` 枚举生成）：\n';

export function buildSwaggerConfig(customize: SwaggerCustomize = {}) {
  return new DocumentBuilder()
    .setTitle(customize.title ?? DEFAULT_SWAGGER_TITLE)
    .setDescription(buildSwaggerDescription(customize))
    .setVersion(customize.version ?? DEFAULT_SWAGGER_VERSION)
    .addBearerAuth()
    .build();
}

function buildSwaggerDescription(customize: SwaggerCustomize): string {
  // 不传 extraDescription 时不插那对换行：默认输出必须与加这段之前逐字节相同，
  // 否则 test/openapi-contract 的「与 docs/openapi.json 完全一致」会被自己打破。
  const narrative = customize.extraDescription
    ? `${ENVELOPE_DESCRIPTION}${customize.extraDescription}\n\n`
    : ENVELOPE_DESCRIPTION;

  return (
    narrative +
    ERROR_TABLE_HEADER +
    buildErrorCodeTable(customize.extraErrorCodes)
  );
}

/** 错误码表由 ERROR_CODE_DESCRIPTIONS 生成——手抄的副本一定会漂移 */
function buildErrorCodeTable(extra?: Readonly<Record<number, string>>): string {
  const base = Object.entries(ERROR_CODE_DESCRIPTIONS).map(
    ([code, description]) => `- ${code} ${description}`,
  );
  const additions = Object.entries(extra ?? {}).map(
    ([code, description]) => `- ${code} ${description}`,
  );
  return [...base, ...additions].join('\n');
}

export const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

/**
 * 判据：operation 有「用户输入」⇒ 400 可能发生（R5）。
 * 导出供测试与 generate-openapi.ts 共用——判据只应有一处定义。
 */
export function hasUserInput(operation: {
  parameters?: unknown[];
  requestBody?: unknown;
}): boolean {
  return (
    (operation.parameters !== undefined && operation.parameters.length > 0) ||
    operation.requestBody !== undefined
  );
}

/**
 * 给「有用户输入」的 operation 注入 400 响应（裁决 R5）。
 *
 * 为什么是程序化注入而不是手写 28 遍：DOC-11 说「统一外壳不逐接口重复」，
 * 所以「全局说一次 + 每个接口各抄一遍」自相矛盾；但只写在全局 description 里，
 * 只读 `responses` 的工具链（含部分 codegen）**看不见 400**。注入两头都占：
 * responses.400 真实存在，且只有一处定义。
 *
 * 为什么带条件而不是无脑全加：`GET /health`、`GET /auth/profile`、
 * `GET /auth/sso/authorize` 这类**没有输入**的接口，400 是不可能发生的——
 * 无脑全加就是在文档里说假话。判据从文档自身取：有 `parameters` 或 `requestBody`
 * ⇒ 有用户输入 ⇒ 校验可能失败 ⇒ 400 可能发生。
 *
 * 代价：400 的注解不在 Controller 源码里，只看源码的人看不见它。
 * 缓解：test/openapi-contract.e2e-spec.ts 断言「有输入的都有 400、没输入的一个都没有」。
 */
export function withValidationErrorResponses<T extends { paths: PathsObject }>(
  document: T,
): T {
  for (const pathItem of Object.values(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = (pathItem as Record<string, unknown>)[method] as
        | {
            parameters?: unknown[];
            requestBody?: unknown;
            responses: Record<string, unknown>;
          }
        | undefined;

      if (operation === undefined) {
        continue;
      }

      const hasInput = hasUserInput(operation);

      if (!hasInput || operation.responses['400'] !== undefined) {
        continue;
      }

      operation.responses['400'] = {
        description:
          '参数失败（10001）。管道校验失败时 data.fields 给出逐字段清单（schema 如右）；业务层参数失败时 data 为 null。详见全局说明',
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/ValidationErrorResponseDto',
            },
          },
        },
      };
    }
  }

  return document;
}

/** Nest 元数据键的字面值——不 import `@nestjs/common/constants` 的内部路径 */
const ROUTE_PATH_KEY = 'path';
const ROUTE_METHOD_KEY = 'method';

const REQUEST_METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
};

function joinRoutePath(controllerPath: string, methodPath: string): string {
  const segments = `${controllerPath}/${methodPath}`
    .split('/')
    .filter((segment) => segment !== '');
  return `/${segments.join('/')}`;
}

/**
 * 从 Nest 元数据读出被 `@Public()` 标记的路由（类级与方法级都算），形如 `GET /health`。
 *
 * 文档侧与契约测试**共用这一份**：各写一遍的话，公开面漂了只会有一边发现。
 */
export function collectPublicRoutes(app: INestApplication): string[] {
  // DiscoveryService 未在 AppModule 注册，从 ModulesContainer 构造一个本地实例
  const discovery = new DiscoveryService(app.get(ModulesContainer));
  const reflector = app.get(Reflector);
  const routes: string[] = [];

  for (const wrapper of discovery.getControllers()) {
    const metatype = wrapper.metatype as
      (new (...args: never[]) => unknown) | undefined;
    if (metatype === undefined) {
      continue;
    }

    const controllerPath =
      (Reflect.getMetadata(ROUTE_PATH_KEY, metatype) as string | undefined) ??
      '';

    for (const methodName of Object.getOwnPropertyNames(metatype.prototype)) {
      const handler: unknown = (metatype.prototype as Record<string, unknown>)[
        methodName
      ];
      if (typeof handler !== 'function') {
        continue;
      }

      const methodPath = Reflect.getMetadata(ROUTE_PATH_KEY, handler) as
        string | undefined;
      const verb = Reflect.getMetadata(ROUTE_METHOD_KEY, handler) as
        RequestMethod | undefined;
      if (methodPath === undefined || verb === undefined) {
        continue; // 不是路由处理器
      }

      const isPublic =
        reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
          handler,
          metatype,
        ]) === true;
      if (isPublic) {
        routes.push(
          `${REQUEST_METHOD_NAMES[verb] ?? String(verb)} ${joinRoutePath(controllerPath, methodPath)}`,
        );
      }
    }
  }

  return routes;
}

/**
 * 把鉴权声明落进文档。
 *
 * **只调 `addBearerAuth()` 是不够的**：那只在 `components.securitySchemes` 里登记
 * 一个方案，没有任何 operation 引用它。症状是 Swagger 上每条接口都没有锁图标、
 * 点了 Authorize 也不会把 token 发出去——看上去「接口全是公开的」，实际每个请求都 401。
 *
 * 收法：顶层 `security` 声明「默认要 bearer」，再按 `@Public()` 元数据把免登录的
 * 那几条显式写成 `security: []`（空数组 = 覆盖顶层默认）。**名单不手抄**——
 * 手抄的副本一定会与 `@Public()` 漂开。
 */
export function applySecurityRequirements(
  app: INestApplication,
  document: OpenAPIObject,
): void {
  document.security = [{ bearer: [] }];

  for (const route of collectPublicRoutes(app)) {
    const separator = route.indexOf(' ');
    const method = route.slice(0, separator).toLowerCase();
    const path = route.slice(separator + 1);

    const pathItem = document.paths[path] as
      Record<string, unknown> | undefined;
    const operation = pathItem?.[method] as
      { security?: unknown[] } | undefined;
    if (operation !== undefined) {
      operation.security = [];
    }
  }
}

/**
 * 在线文档开不开。读 `swagger.enabled`（见 `configuration.ts`：不配时按 `NODE_ENV` 走）。
 *
 * 手搭的最小测试模块可能没有 ConfigModule——与上面 CORS 那段同口径：读不到就当开，
 * 与「非生产默认开」一致。
 */
function isSwaggerEnabled(app: INestApplication): boolean {
  try {
    return (
      app
        .get(ConfigService, { strict: false })
        .get<boolean>('swagger.enabled') ?? true
    );
  } catch {
    return true;
  }
}

/**
 * 建出**唯一一份** OpenAPI 文档：在线文档（/api-docs）与 scripts/generate-openapi.ts
 * 都走这里。此前两处各自 createDocument，漂移只是时间问题——R5 要求「两个调用点必须
 * 同时接」，抽成一个函数比"记得改两处"可靠。
 */
export function buildDocument(
  app: INestApplication,
  customize?: SwaggerCustomize,
) {
  const document = SwaggerModule.createDocument(
    app,
    buildSwaggerConfig(customize),
    {
      extraModels: swaggerExtraModels,
    },
  );

  applySecurityRequirements(app, document);

  return withValidationErrorResponses(document);
}

/**
 * 这些 schema 只出现在全局说明的「校验失败形状」里（DOC-11：统一外壳不逐接口重复），
 * 没有任何接口以它们为响应类型，所以必须用 extraModels 显式挂进 components.schemas。
 */
export const swaggerExtraModels = [
  ValidationErrorResponseDto,
  ValidationErrorDataDto,
  FieldErrorDto,
];

/** {@link configureApp} 的可选开关。目前只有 Swagger 定制一项。 */
export interface ConfigureAppOptions {
  swagger?: SwaggerCustomize;
}

export function configureApp(
  app: INestApplication,
  options?: ConfigureAppOptions,
): void {
  // 1. 请求上下文。必须最先注册——后面的管道、拦截器、过滤器
  //    以及 Prisma 查询扩展都从它读 traceId 与当前操作者。
  app.use((req: unknown, _res: unknown, next: () => void) => {
    requestContext.run({ traceId: randomUUID() }, next);
  });

  // 2. 全局校验管道（规范 DTO-05）
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // 必须为 false：打开后 ?page=abc 会静默变成 NaN 一路流进 Service，
      // 而不是在边界被拦下。类型转换改为在 DTO 上显式写 @Type()。
      transformOptions: { enableImplicitConversion: false },
      exceptionFactory: validationExceptionFactory,
    }),
  );

  // 3. 全局响应外壳（规范 RES-01）+ 数据范围上限（@DataScope → 请求上下文）
  app.useGlobalInterceptors(
    new ResponseInterceptor(app.get(Reflector)),
    new DataScopeInterceptor(),
  );

  // 4. 全局异常收口（规范 ERR-04 / ERR-05）
  app.useGlobalFilters(new AllExceptionsFilter());

  // 5. 安全响应头。helmet 顺带就会去掉 x-powered-by，
  //    它是那些"扫一遍就知道你用什么框架"的扫描器最省事的信息来源。
  app.use(helmet());

  // CORS 白名单（spec 附带四项第 2 项）。
  // **不用 `origin: true`**——那会把 Access-Control-Allow-Origin 回成任意来源，
  // 等于把同源策略关掉。空名单 = 拒绝一切跨域（fail-closed）：
  // 本地前端连不上时，先看 CORS_ORIGINS 有没有把它的来源列进去。
  let corsOrigins: string[] = [];
  try {
    corsOrigins =
      app.get(ConfigService, { strict: false }).get<string[]>('cors.origins') ??
      [];
  } catch {
    // 手搭的最小测试模块可能没有 ConfigModule；空数组 = fail-closed
  }

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });

  app.enableShutdownHooks();

  if (isSwaggerEnabled(app)) {
    SwaggerModule.setup('api-docs', app, buildDocument(app, options?.swagger));
  } else {
    // 静默 404 会让人以为服务没起好。关掉是**有意的**，就明说一句。
    new Logger('Bootstrap').log(
      '在线文档已关闭：SWAGGER_ENABLED 为假，或 NODE_ENV=production 且未显式开启',
    );
  }
}

// 这里不要加 `as const`：加上后 load 会被收窄成 readonly [() => AppConfig]，
// 不再兼容 ConfigModuleOptions.load 要求的可变 ConfigFactory[]（TS2345）。
export const configModuleOptions = {
  isGlobal: true,
  load: [configuration],
  validate: validateEnv,
};
