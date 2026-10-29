# 后台编码规范

本项目所有后台接口开发必须遵守本规范。规范以**编号条款**组织，评审时可直接引用条款编号
（例如"这里违反 DTO-03"），无需复述内容。

- 等级 `[必须]`：不满足则评审不通过
- 等级 `[禁止]`：出现即评审不通过
- 等级 `[推荐]`：允许有理由地偏离，偏离理由需在 PR 中说明

条款编号 `前缀-序号`，前缀按章分配（`FLOW` / `DTO` / `RES` / `LAYER` / `ERR` / `NAME` / `DB` / `DOC`）。
**编号一经分配永不复用**，删除条款时保留空号——否则历史评审中引用的编号会指向别的条款。

本规范不绑定 ORM / 鉴权 / 接口文档工具的选型。条款正文统一使用泛称："数据访问层"
（不写 ORM 产品名）、"接口文档工具"（不写具体工具名）、"校验管道"、"文档注解"。
代码示例使用 NestJS 自身写法，不代表对第三方库的选型要求。

DDL 示例以 **MySQL 8.0** 为准：主键为 `BIGINT UNSIGNED` 自增（对外序列化为字符串）、
时间列用 `DATETIME(3)` 存 UTC。这一项是**明确绑定**的——示例要被直接拷贝使用，
写成语义近似的其它方言反而会误导。换数据库时须同步修订第 8 章的全部示例。

## 目录

1. [总则](#1-总则)
2. [标准开发工序](#2-标准开发工序)
3. [输入契约：请求 DTO 与校验](#3-输入契约请求-dto-与校验)
4. [输出契约：响应 DTO 与统一响应结构](#4-输出契约响应-dto-与统一响应结构)
5. [分层职责](#5-分层职责)
6. [异常与错误码](#6-异常与错误码)
7. [命名与文件组织](#7-命名与文件组织)
8. [数据表与审计字段](#8-数据表与审计字段)
9. [接口文档](#9-接口文档)
- [附录 A 评审速查清单](#附录-a-评审速查清单)

## 1. 总则

### 1.1 适用范围

适用于本项目全部后台业务代码与接口。数据库表设计、接口文档维护同样受本规范约束。
测试规范、Git 提交与分支规范、CI/CD、部署不在本规范范围内。

### 1.2 条款优先级

当本规范与个人习惯冲突时，以本规范为准。当本规范与框架的强制要求冲突时，以框架为准，
但需在 PR 中说明。新增条款须走评审，不得由单人直接在本文档中追加。

### 1.3 违反成本

`[必须]` 与 `[禁止]` 条款不是风格偏好，每条都对应一个具体的、已经发生过的失败模式。
`**为什么**` 一节写的是这条失败模式的代价，不是条款的复述。评审时若认为某条不再适用，
应当提案删除该条款，而不是在单次 PR 中默默偏离。

## 2. 标准开发工序

"先写 DTO"不是形式主义。DTO 是接口契约的**唯一载体**：它一旦写出来，这个接口收什么、
回什么、哪些字段必填、哪些值合法，就全部可见、可评审、可被工具校验。反过来，先写实现
再补校验，契约就散落在 Service 的判断分支里——任何人在通读实现之前，都说不出这个接口的形状。

本章规定新接口的固定工序。后续各章的条款，都是为了让这个工序里的每一步都站得住。

### FLOW-01 `[必须]` 动手写 Controller 之前，先写出该接口的请求 DTO 和响应 DTO

**为什么**：Controller 签名一旦落笔，接口契约就固定了。此时若 DTO 还不存在，开发者只能写
`@Body() body: any` 之类的占位——这个占位要么被忘记，要么在补的时候按实现的方便、而不是按
接口的合理来设计字段。

**✅ 正例**

```ts
// 第一步只产出这两个类，不写任何实现
export class CreateUserDto {
  @IsString()
  @Length(2, 20)
  name: string;
}

export class UserResponseDto {
  @IsString()
  id: string;

  @IsString()
  name: string;
}
```

**❌ 反例**

```ts
// 契约未定，先用 any 占位——这个 any 通常会一直活到上线
@Post()
async create(@Body() body: any): Promise<any> {
  // ...
}
```

### FLOW-02 `[必须]` 固定工序：定义 DTO → 写 Controller 签名 → 写 Service 与数据访问 → 补测试

**为什么**：工序的价值在于**顺序**。当 Controller 签名先于实现写完时，接口契约就已经完全可读，
评审可以在没有任何业务代码的情况下进行；而当实现先写完时，评审者只能被动接受已经成型的实现，
契约设计的问题会在最贵的时刻才被发现。

**✅ 正例**

```ts
// 工序第 2 步：签名先写完，实现留到第 3 步。此刻契约已完全可读
@Post()
async create(@Body() dto: CreateUserDto): Promise<UserResponseDto> {
  return this.userService.create(dto); // 实现见第 3 步
}
```

**❌ 反例**

```ts
// 跳过 DTO 直接写实现：契约只能靠通读代码反推，
// 且这一段同时违反 DTO-01、LAYER-01、LAYER-02、RES-03、RES-04、RES-05
@Post()
async create(@Body() body: any) {
  if (!body.name || body.name.length < 2) {
    throw new BadRequestException('名字太短');
  }
  const user = await this.repo.save({ ...body, createdAt: new Date() });
  delete user.password;
  return user;
}
```

### FLOW-03 `[必须]` Controller 方法必须显式标注返回类型，且该类型是 Response DTO

**为什么**：省略返回类型时，TypeScript 会从实现里推断——而实现返回的往往是实体或临时拼装的对象。
返回类型是接口契约的后半句，它不应该由实现细节决定。

**✅ 正例**

```ts
@Get(':id')
async findOne(@Param() params: FindUserParamDto): Promise<UserResponseDto> {
  return this.userService.findOne(params.id);
}
```

**❌ 反例**

```ts
// 省略返回类型，推断出的是实体类型——响应结构从此由实体定义，
// 实体加一个 password 字段，接口就泄露一个字段
@Get(':id')
async findOne(@Param() params: FindUserParamDto) {
  return this.userService.findOne(params.id);
}
```

### FLOW-04 `[推荐]` 先让 DTO 作为契约通过评审，再实现业务逻辑

**为什么**：DTO 的改动成本在实现之前几乎为零，在实现之后则要连带改 Service、改测试、改前端联调。
把契约评审前置，是用最低成本挡住最高成本返工的手段。

**✅ 正例**

```text
PR #12  接口契约：新增用户创建接口的 DTO
  - 新增 CreateUserDto / UserResponseDto
  - Controller 签名已写，Service 方法暂返回固定桩数据
  → 评审通过后，PR #13 补实现
```

**❌ 反例**

```text
PR #12  新增用户创建接口（含 DTO、Service、数据访问、测试）
  - 评审意见：name 不应该是必填、应该支持批量创建
  → 契约问题在第 400 行代码写完之后才被发现
```

## 3. 输入契约：请求 DTO 与校验

本章是全规范的核心。接口的输入必须完全由 DTO 定义，且 DTO 上的约束必须真正生效——
不是"写了装饰器"，而是"装饰器确实拦住了非法输入"。

### DTO-01 `[必须]` 进入 Controller 的所有输入（body / query / param）都必须由 DTO 承接，禁止裸接对象或 `any`

**为什么**：裸接的输入没有类型、没有校验、没有文档来源——它是"接口契约"这个词唯一的反面。
逐字段裸接（`@Query('page') page: string`）同样违规，只是更隐蔽。

**✅ 正例**

```ts
@Post()
async create(@Body() dto: CreateUserDto): Promise<UserResponseDto> { /* ... */ }

@Get()
async list(@Query() query: QueryUserDto): Promise<PageResponseDto<UserResponseDto>> { /* ... */ }

@Get(':id')
async findOne(@Param() params: UserParamDto): Promise<UserResponseDto> { /* ... */ }
```

**❌ 反例**

```ts
@Post()
async create(@Body() body: any) { /* ... */ }

// 逐字段裸接同样违规：单个标量参数没有元数据类型，
// 校验管道不会介入，?page=abc 会原样进到代码里
@Get()
async list(@Query('page') page: string, @Query('pageSize') pageSize: string) { /* ... */ }
```

### DTO-02 `[必须]` body、query、param 各自独立 DTO，禁止一个 DTO 兼任多种输入

**为什么**：三种输入的约束完全不同——同一个 `id` 在 param 里必填、在 body 里可能不该出现。
合用一个类就只能把它们的约束一律放宽为"可选"，参数校验形同虚设。

**✅ 正例**

```ts
export class CreateUserDto {   // body
  @IsString() @Length(2, 20)
  name: string;

  @IsEmail()
  email: string;
}

export class QueryUserDto {    // query
  @Type(() => Number) @IsInt() @Min(1)
  page: number;
}

export class UserParamDto {    // param
  @IsBigIntId()                // 主键为 BIGINT，对外是数字字符串
  id: string;
}
```

**关于大整数入参**：`id` 这类 `BIGINT` 字段的入参一律用 `@IsBigIntId()`（定义在
`src/common/decorators/is-bigint-id.decorator.ts`），**不要退回 `@IsNumberString()`**——
后者默认放行 `1.5` / `-1` / `+1`，`BigInt('1.5')` 会抛 `SyntaxError`，绕过业务异常直接变成 500；
位数超过 `2^63-1` 也过不了 Prisma 的参数绑定。**查询参数同样适用**（如 `GET /users?roleId=`），
那里同样是用户可控的大整数。

**❌ 反例**

```ts
// 一个类兼任三种输入：为了同时满足三种场景，所有约束只能放宽为可选
export class UserDto {
  @IsOptional() @IsNumberString()
  id?: string;

  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsInt()
  page?: number;
}
// 结果：创建接口漏传 name 也能通过，因为 name 是"可选"的
```

### DTO-03 `[必须]` DTO 必须是 `class`，禁止 `interface` / `type`

**为什么**：校验依赖运行时元数据，而 `interface` 和 `type` 在编译后会被完全抹除。
这是一类最危险的错误——它**看起来在工作**：能编译、IDE 类型提示正常、代码评审也看不出问题，
但校验从头到尾没有触发过一次。

**适用边界**：本条只约束**经校验管道的输入 / 输出契约**——即 DTO-09 命名白名单内、挂校验装饰器、
随请求进出的那些类型。**域形状 / 快照形状不在此列**：`snapshot` 的字段表、状态机的入参形状、
持久层内部的行形状之类，它们不过校验管道，用 `type` / `interface` 是对的，套 `class` 反而多出
一套没人用的元数据。判据只有一条：**这个类型会不会出现在 Controller 的 `@Body()` / `@Query()` /
`@Param()` / 返回类型上，或嵌套在里面**。会，就必须是 `class`；不会，DTO-03 不管。

**✅ 正例**

```ts
export class CreateUserDto {
  @IsString()
  @Length(2, 20)
  name: string;
}
```

**❌ 反例**

```ts
interface CreateUserDto {
  name: string;
}
// 能编译通过，类型提示正常，但校验管道拿不到任何元数据：
// 请求传 {} 或 { name: 12345 } 都会一路进到 Service
```

### DTO-04 `[必须]` 每个字段都要有显式校验装饰器；确实无需约束的字段也要显式声明类型装饰器

**为什么**：白名单是按"有没有校验装饰器"判定的，不是按"有没有声明类型"。没有装饰器的字段
不在白名单内，会触发下面两种症状之一——而这两种症状都极难从报错信息反推到"我少写了个装饰器"。

**✅ 正例**

```ts
export class CreateUserDto {
  @IsString() @Length(2, 20)
  name: string;

  @IsString()              // 无长度约束，但仍显式声明类型
  remark: string;

  @IsOptional() @IsString()
  nickname?: string;
}
```

**❌ 反例**

```ts
export class CreateUserDto {
  @IsString() @Length(2, 20)
  name: string;

  remark: string;   // 裸字段：没有任何装饰器，不在白名单内
}
// 症状一（开启了 forbidNonWhitelisted）：
//   请求带 remark 直接返回 400 "property remark should not exist"，
//   开发者的直觉是"我刚加了个字段，为什么接口全挂了"。
// 症状二（只开 whitelist 未开 forbidNonWhitelisted）：
//   remark 被静默剥离，代码里永远拿到 undefined，没有任何报错。
```

### DTO-05 `[必须]` 全局校验管道必须开启：剥离未声明字段 + 未声明字段直接报错 + 实例化转换

**为什么**：三个开关缺一不可，各自挡住不同的失败模式。少开任何一个，DTO 上的装饰器就会
部分或全部失效，而失效是静默的。

**✅ 正例**

```ts
// 全局注册，只在此处配置一次
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,             // 剥离未声明字段
    forbidNonWhitelisted: true,  // 未声明字段直接报错，而非静默剥离
    transform: true,             // 实例化为 DTO 类，嵌套校验与白名单级联才生效
  }),
);
```

**❌ 反例**

```ts
// 反例一：完全没有注册管道——所有 DTO 上的装饰器都只是装饰品
const app = await NestFactory.create(AppModule);
await app.listen(3000);
```

```ts
// 反例二：注册了但只开一部分，同样危险
app.useGlobalPipes(new ValidationPipe({ transform: true }));
// 缺 whitelist：客户端可往请求里塞任意字段（DTO-12 的越权风险由此而来）
// 缺 forbidNonWhitelisted：塞进来的字段被静默丢弃，
//   前端以为传了、后端说没收到，双方各查半天
```

### DTO-06 `[必须]` 嵌套对象 / 数组必须显式声明嵌套校验与元素类型，否则白名单在嵌套层失效

**为什么**：白名单只能剥离它"看得见"的层。嵌套对象若没有被实例化成 class，它的属性对校验
管道而言完全不可见——在嵌套层写多少装饰器都不会生效，客户端可以往嵌套结构里塞任意字段。

**✅ 正例**

```ts
export class CreateOrderDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)   // 缺这一行，下面的元素校验全部失效
  items: OrderItemDto[];
}

export class OrderItemDto {
  @IsString()
  productId: string;

  @IsInt() @Min(1)
  quantity: number;
}
```

**❌ 反例**

```ts
export class CreateOrderDto {
  @IsArray()
  @ValidateNested({ each: true })
  items: OrderItemDto[];   // 没有 @Type：元素仍是普通对象，不是 OrderItemDto 实例
}
// quantity 传 -1、传 "abc"，甚至塞 { quantity: 1, unitPrice: 0.01 }
// 都能通过——嵌套层的校验与白名单同时失效
```

### DTO-07 `[推荐]` 类型转换（字符串 → 数字 / 日期）在 DTO 层完成，Service 不做补救式转换

**为什么**：query 参数永远是字符串。若在 Service 里补救式转换，那么"DTO 是接口契约的唯一载体"
就不再成立——契约里每个字段声明的类型，都不等于它实际拿到的类型。

**✅ 正例**

```ts
export class QueryUserDto {
  @Type(() => Number)
  @IsInt() @Min(1)
  page: number;   // Service 拿到的就是 number
}
```

**❌ 反例**

```ts
// DTO 声明成字符串，类型与事实不符
export class QueryUserDto {
  @IsString()
  page: string;
}

// Service 里每个用到的地方都要补救一次，漏一处就是 bug
const page = Number(dto.page);
```

### DTO-08 `[禁止]` DTO 中不得出现业务方法、依赖注入、数据访问调用

**为什么**：DTO 是数据契约，不是对象。给它注入依赖或加业务方法，就等于把一个跨层的胖对象
塞进了接口签名——它再也无法被独立测试，也无法被安全地序列化与传输。

**✅ 正例**

```ts
export class CreateUserDto {
  @IsString() @Length(2, 20)
  name: string;
}

// 需要派生逻辑（如判重、格式化）时，放在 Service 或独立的 mapper 中
```

**❌ 反例**

```ts
export class CreateUserDto {
  constructor(private readonly userRepo: UserRepository) {}

  @IsString()
  name: string;

  async isNameTaken(): Promise<boolean> {
    return (await this.userRepo.countByName(this.name)) > 0;
  }
}
```

### DTO-09 `[必须]` 命名固定为 `CreateXxxDto` / `UpdateXxxDto` / `QueryXxxDto` / `XxxParamDto` / `XxxResponseDto`

**为什么**：命名是唯一能在不打开文件的情况下，区分"这是入参还是出参、属于哪一类入参"的信息。
命名不统一时，读签名的人必须逐个打开文件才能确认数据流向。

**白名单只覆盖五类常规入出参**。**动作体（action body）不在此列**：一次性的命令式请求体——
`SubmitOnboardDto` / `CollegeReviewDto` / `ApproveApplicationDto` 这类「提交 / 审核 / 通过」的 body——
它们不是 Create / Update 的 CRUD 语义，硬套 `CreateXxxDto` 会把「提交入驻」和「建一条申请」混成一个名字。
动作体命名取 **`<动作><资源>Dto`**（动词用领域动词，不用 Create / Update 兜底），
仍须满足 DTO-03 / DTO-04 / DTO-11。

**✅ 正例**

```ts
CreateUserDto      // 创建接口的 body
UpdateUserDto      // 更新接口的 body
QueryUserDto       // 列表接口的 query
UserParamDto       // 单条接口的 param
UserResponseDto    // 用户相关接口的响应
```

**❌ 反例**

```ts
UserDto         // 入参还是出参？哪个接口在用？
UserRequest     // 后缀自成一套
CreateUserDTO   // 缩写大小写不统一
```

### DTO-10 `[推荐]` 分页查询继承统一分页基类，且必须给 `pageSize` 设上限

**为什么**：不设上限的 `pageSize` 是一个随时会被触发的拒绝服务入口——`?pageSize=1000000`
一次请求就能把数据库与内存打满。这个上限必须写进契约，不能指望调用方自觉。

**✅ 正例**

```ts
export class PageQueryDto {
  @Type(() => Number)
  @IsInt() @Min(1)
  page: number = 1;

  @Type(() => Number)
  @IsInt() @Min(1) @Max(100)   // 上限写进契约
  pageSize: number = 20;
}

export class QueryUserDto extends PageQueryDto {
  @IsOptional() @IsString()
  keyword?: string;
}
```

**❌ 反例**

```ts
export class QueryUserDto {
  @IsOptional() @Type(() => Number) @IsInt()
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt()
  pageSize?: number;   // 无上限：?pageSize=1000000 即可打满数据库
}
```

### DTO-11 `[必须]` 接口文档注解与校验装饰器写在同一个 DTO 上，禁止在 Controller 上重复描述字段

**为什么**：接口文档由 DTO 上的注解生成，"注解写在哪"直接决定文档有没有内容。把字段描述写在
Controller 上，等于把文档的来源从"字段定义处"挪到了"接口入口处"——字段改了、Controller 上的
描述没改，文档开始说谎，而且没有任何机制会提醒你。

> 示例中的文档注解使用了本生态最常见的写法；具体工具在选型确定后替换，条款本身与工具无关。

**✅ 正例**

```ts
export class CreateUserDto {
  @ApiProperty({ description: '用户姓名', example: '张三' })
  @IsString() @Length(2, 20)
  name: string;
}
// 描述与约束在同一行上下，改名、改约束、改说明永远同步
```

**❌ 反例**

```ts
@Post()
@ApiOperation({ summary: '创建用户' })
@ApiBody({ schema: { properties: { name: { type: 'string', description: '用户姓名' } } } })
async create(@Body() dto: CreateUserDto): Promise<UserResponseDto> { /* ... */ }

export class CreateUserDto {
  @IsString() @Length(2, 20)
  name: string;   // 改名为 username 时，上面的描述不会报错，只会继续描述一个不存在的字段
}
```

### DTO-12 `[禁止]` 禁止把请求 DTO 直接透传持久化，必须显式映射（防批量赋值越权改字段）

**为什么**：请求 DTO 的字段由客户端控制。直接透传意味着客户端可以写任何与实体同名的字段——
包括那些从未打算让用户设置的字段（角色、状态、余额、创建时间）。这是越权漏洞，不是风格问题。

**✅ 正例**

```ts
// Service 中显式挑字段
const user = await this.userRepo.create({
  name: dto.name,
  email: dto.email,
  // role 由服务端决定，不来自请求
  role: UserRole.Guest,
});
```

**❌ 反例**

```ts
@Patch(':id')
async update(@Param() params: UserParamDto, @Body() dto: UpdateUserDto) {
  return this.userRepo.update(params.id, dto);   // dto 里出现 role 就能提权
}
// 即使 DTO 上没声明 role，只要 DTO-05 的白名单没开，
// 客户端传 { "role": "admin" } 就会原样落到实体上
```

### DTO-13 `[推荐]` 更新类接口的 DTO 由创建 DTO 派生（全字段可选），避免两处维护

**为什么**：创建与更新的字段集合几乎总是重合，唯一的差别是全部选填。手写两份的代价不是多敲字，
而是字段改名或改约束时只改了一处——两份契约从此静默地不一致。

**✅ 正例**

```ts
export class CreateUserDto {
  @IsString() @Length(2, 20)
  name: string;

  @IsEmail()
  email: string;
}

export class UpdateUserDto extends PartialType(CreateUserDto) {}
// 约束跟着 CreateUserDto 走：改名、调长度限制都不会漏掉更新接口
```

**❌ 反例**

```ts
export class UpdateUserDto {
  @IsOptional() @IsString() @Length(2, 20)
  name?: string;

  @IsOptional() @IsEmail()
  email?: string;
}
// 与 CreateUserDto 重复定义。下次把 name 的长度限制改成 1-50 时只改了 CreateUserDto，
// 创建与更新开始接受不同的数据，且没有任何地方会报错
```

### DTO-14 `[必须]` `@IsOptional()` 必须显式决定 `null` 的含义

**为什么**：class-validator 的 `@IsOptional()` 跳过校验的条件是 `value === undefined || value === null`——
**两个都跳**。于是同一个字段上的 `null` 有三种可能的语义，不写下来就没人知道是哪一种：

1. `null` 与「不传」同义，落到持久层时按"没有值"处理（可空列）
2. `null` 是**清空该字段**的显式指令（可空列，前端给一个"清除"按钮）
3. `null` 非法，必须直接报错（非空列、或"清空"另有语义）

这三种在同一个系统里可以并存（`mobile` 是 ①②，`username` 是 ③），所以**每个字段**都要单独决定，
不能"看别的字段怎么写的"。不决定的后果是静默的：`@IsOptional() @IsString()` 遇到 `null` 时校验直接放行，
`null` 一路流到 Prisma——非空列抛 P2011/约束错误变成 500，可空列则把"没传"与"清空"混为一谈。

**✅ 正例**

```ts
export class UpdateUserDto {
  /** null 与不传同义：都表示「没有手机号」（语义 ①） */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  mobile?: string | null;

  /** null 非法：用户名没有"清空"这回事（语义 ③）——在 Service 里显式拒掉 */
  @IsOptional()
  @IsString()
  @Length(3, 50)
  username?: string;
}
// Service.update() 开头：
//   if (dto.username === null) throw new BusinessException(PARAM_INVALID, 'username 不能为 null', 400);
```

**❌ 反例**

```ts
export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Length(3, 50)
  username?: string;
}
// 传 { "username": null } 时校验静默放行。落到非空列变成 500，落到可空列则把
// 「清空用户名」当成了合法操作——而调用者多半只是打错了字
```

**配套做法**：语义 ③ 的字段在 Service 的入口处集中拒一次（一个 `assertNoNullFields` 的私有方法），
错误码用 `10001 PARAM_INVALID`，消息里点名是哪个字段。**不要**靠 DTO 的 `@ValidateIf` 去拒——
那会把"哪个字段不能为 null"的知识拆到每个 DTO 里，与 DTO-13 反对的两处维护是同一个毛病。

## 4. 输出契约：响应 DTO 与统一响应结构

所有接口的成功响应与失败响应共用同一个外壳：

```jsonc
// 成功
{ "code": 0, "message": "ok", "data": { }, "traceId": "..." }

// 失败
{ "code": 21102, "message": "用户名已存在", "data": null, "traceId": "..." }
```

`data` 的具体字段由各接口的 Response DTO 定义。`traceId` 为可选附加字段，接入链路追踪后启用。

注意：外壳由全局拦截器补，**Controller 仍然返回 Response DTO**（见 RES-03 与 FLOW-03）。
这两件事不矛盾——Controller 负责"这个接口的数据长什么样"，拦截器负责"所有接口共同的包装"。

### RES-01 `[必须]` 所有接口返回统一外壳 `{ code, message, data }`，成功时 `code` 恒为 `0`

**为什么**：前端只需要写一套响应解析逻辑。若各接口自行决定返回形状，前端要为每个接口单独适配，
而这个成本会随接口数量增长而复利——它是少数会随规模恶化的重复劳动。

**✅ 正例**

```ts
// 全局响应拦截器统一补外壳，Controller 只返回业务数据
// 拦截器内部：
return { code: 0, message: 'ok', data };   // data 即 Controller 返回的 Response DTO
```

**❌ 反例**

```ts
// 没有全局拦截器，各接口自行拼外壳——很快就会出现三种以上写法
@Get(':id')
async findOne(@Param() params: UserParamDto) {
  return { success: true, result: await this.userService.findOne(params.id) };
}

@Get()
async list(@Query() query: QueryUserDto) {
  return { errcode: 0, data: await this.userService.list(query) };
}
// 前端要为每个接口单独判断该读 success 还是 errcode 还是 code
```

### RES-02 `[必须]` HTTP 状态码保留传输语义，不被外壳替代

**为什么**：HTTP 状态码是网关、监控、浏览器与客户端重试逻辑共同依赖的信号。把它一律压成 200
只为在 body 里区分业务错误，等于让所有基础设施层面的失败感知同时失灵——而这些失灵是静默的。

**✅ 正例**

```ts
// 传输语义与业务语义各自表达，互不替代
throw new NotFoundException({ code: 21101, message: '用户不存在' });
// → HTTP 404
//   body: { "code": 21101, "message": "用户不存在", "data": null }
```

**❌ 反例**

```ts
// 业务失败也返回 HTTP 200，只靠 code 区分
@Get(':id')
async findOne(@Param() params: UserParamDto) {
  const user = await this.userService.findOne(params.id);
  if (!user) {
    return { code: 21101, message: '用户不存在', data: null };   // HTTP 仍是 200
  }
  return { code: 0, message: 'ok', data: user };
}
// 代价：网关无法按状态码限流或熔断、监控看不到失败率、
// 客户端与浏览器的重试和缓存逻辑全部失真
```

### RES-03 `[必须]` 每个接口必须定义 Response DTO 并作为 Controller 方法返回类型；禁止返回实体、`any`、匿名对象

**为什么**：返回类型是接口契约的后半句。没有 Response DTO，响应结构就由实体当前的字段决定——
实体加一个字段，接口就多返回一个字段，且没有任何机制提示这是一次接口变更。

**✅ 正例**

```ts
@Get(':id')
async findOne(@Param() params: UserParamDto): Promise<UserResponseDto> {
  return this.userService.findOne(params.id);
}
```

**❌ 反例**

```ts
@Get(':id')
async findOne(@Param() params: UserParamDto): Promise<any> { /* ... */ }

@Get()
async list(): Promise<object> { /* ... */ }
// any / object / 省略返回类型——三种写法等价于"这个接口没有契约"
```

**例外（204 接口）**：返回 `Promise<void>`、响应体为空、走 `@NoEnvelope` 标注，不得另搞花样——这是唯一允许不定义 Response DTO 的形态。

### RES-04 `[必须]` 响应字段必须显式映射到 Response DTO，禁止序列化整个实体后直接返回

**为什么**：实体是数据库结构的映射，Response DTO 是接口契约。直接返回实体会让两者永久耦合，
而耦合的代价总在加字段的那一天兑现——包括那些本不该对外可见的字段。

**✅ 正例**

```ts
// Service 中显式映射
private toResponse(user: UserEntity): UserResponseDto {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
  };
}
```

**❌ 反例**

```ts
@Get(':id')
async findOne(@Param() params: UserParamDto) {
  return this.userRepo.findOne(params.id);   // 实体上有什么，接口就返回什么
}
// 明天实体加一个 internalNote 字段用于后台备注，
// 这个接口今天就把它吐给了客户端
```

### RES-05 `[禁止]` 响应中不得出现密码、盐、令牌、内部状态字段等敏感信息

**为什么**：敏感字段泄露一次就是事故，而它的成因往往只是"少删了一个字段"。靠"记得 `delete`"
不可靠——漏掉的那一次不会有任何提示，直到被人发现。

**✅ 正例**

```ts
export class UserResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  // password / passwordSalt / internalNote 不出现在这个类里。
  // 它们不在契约中，因此不可能被返回——这是白名单式的保证，不依赖人的记性
}
```

**❌ 反例**

```ts
const user = await this.userRepo.findOne(id);
delete user.password;   // 靠手工删除：漏一个字段就是一次泄露
return user;
```

### RES-06 `[必须]` 列表接口统一分页结构 `{ list, total, page, pageSize }`

**为什么**：分页结构不统一时，前端要为每个列表接口写一套解析逻辑。这与 RES-01 的动机同源——
让客户端只面对一种形状，而不是为每个接口单独适配。

**✅ 正例**

```ts
export class PageResponseDto<T> {
  @ApiProperty({ isArray: true })
  list: T[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  pageSize: number;
}
```

**❌ 反例**

```ts
// 三种分页写法并存，前端要写三套解析
return users;                                    // 裸数组，没有总数
return { rows: users, count: total };            // 换了个名字
return { items: users, total, current: page };   // 又换了一套
```

### RES-07 `[推荐]` 时间统一为 ISO 8601 带时区字符串，不混用时间戳 / 本地化格式

**为什么**：时间格式混用产生的错误是"看起来对、偶尔不对"的类型——跨时区部署或前端本地化显示
时才会暴露，且极难复现。统一格式是一次性成本，排查时区问题是持续成本。

**✅ 正例**

```jsonc
{ "createdAt": "2026-10-08T14:30:00+08:00" }
```

**❌ 反例**

```jsonc
{ "createdAt": 1759902600000 }          // 时间戳，可读性差且易与秒级混用
{ "createdAt": "2026-10-08 14:30:00" }  // 无时区，客户端只能按本地时区猜
```

### RES-08 `[推荐]` 金额与大整数用字符串或最小单位整数，规避 JS number 精度丢失

**为什么**：JS 的 number 是双精度浮点，超过 2^53 的整数会**静默**丢精度。这类错误在小数据量下
完全不出现，直到某天金额或 ID 变大——届时排查范围会非常大。

**✅ 正例**

```jsonc
{ "amount": "199.99" }        // 字符串，交由前端或专用的十进制库处理
{ "amountInCents": 19999 }    // 或最小货币单位整数
```

**❌ 反例**

```jsonc
{ "amount": 199.99 }               // 浮点金额：累加与比较都可能出现误差
{ "orderId": 9007199254740993 }    // 超出 2^53，读回来变成 9007199254740992
```

## 5. 分层职责

Controller / Service / 数据访问层三层，每层只做一件事。本章的条款都是这条原则的展开，
分别针对越界最常见的那几种形式。

### LAYER-01 `[必须]` Controller 只做三件事：收已校验的 DTO、调 Service、返回 Response DTO

**为什么**：Controller 的职责边界一旦模糊，业务逻辑就会按"哪写方便"分散到两层，
之后每次改动都要先确认逻辑究竟在哪一层——这是维护成本上升最快的来源。

**✅ 正例**

```ts
@Post()
async create(@Body() dto: CreateUserDto): Promise<UserResponseDto> {
  return this.userService.create(dto);
}

@Get()
async list(@Query() query: QueryUserDto): Promise<PageResponseDto<UserResponseDto>> {
  return this.userService.list(query);
}
```

**❌ 反例**

```ts
@Post()
async create(@Body() dto: CreateUserDto) {
  const exists = await this.userRepo.countByName(dto.name);   // 数据访问
  if (exists > 0) {                                          // 业务规则
    throw new ConflictException('用户名已存在');
  }
  const user = await this.userRepo.save({ ...dto, createdAt: new Date() });
  return { id: user.id, name: user.name };                   // 响应组装
}
// 这一段的每一步都越界：判重是业务规则、数据访问不属于 Controller、
// 响应组装应由 Service 完成并产出 Response DTO
```

### LAYER-02 `[禁止]` Controller 内不得出现业务判断、循环、数据访问、事务、外部调用

**为什么**：权限判断是最常见的越界形式。当 `if (operator.role !== 'admin')` 出现在 Controller 里，
权限规则就同时存在于 Controller 和 Service 两处，而它们迟早会不一致——
且不一致的那一次，通常表现为"某个入口忘了校验"。

**✅ 正例**

```ts
@Delete(':id')
async remove(@Param() params: UserParamDto): Promise<void> {
  return this.userService.remove(params.id);
}
// 权限校验、级联处理、审计记录都在 Service 内完成
```

**❌ 反例**

```ts
@Delete(':id')
async remove(@Param() params: UserParamDto, @Req() req: Request) {
  const operator = req.user;
  if (operator.role !== 'admin') {              // 权限判断散落在入口层
    throw new ForbiddenException();
  }
  for (const id of params.id.split(',')) {      // 循环
    await this.userRepo.delete(id);             // 数据访问
  }
}
```

### LAYER-03 `[必须]` 业务逻辑与 Response DTO 的组装都在 Service 完成，Controller 不做字段搬运

**为什么**：如果 Controller 负责拼装响应字段，"这个接口返回什么"就分散在两层。
Response DTO 是契约，契约的产出位置必须唯一——否则新增字段时你需要在两个地方同时改，
而漏改的结果是接口返回 `undefined`，不报错。

**✅ 正例**

```ts
// Service：一次产出完整的 Response DTO
async create(dto: CreateUserDto): Promise<UserResponseDto> {
  const user = await this.userRepo.create(this.toEntity(dto));
  return this.toResponse(user);
}
```

**❌ 反例**

```ts
// Controller 搬运字段：新增字段时要在两处同时改
@Post()
async create(@Body() dto: CreateUserDto) {
  const user = await this.userService.create(dto);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    // 漏掉 createdAt —— 契约上声明的字段，接口却返回 undefined
  };
}
```








### LAYER-04 `[必须]` 数据访问只经数据访问层；Service 不直接持有连接、不拼 SQL

**为什么**：Service 直接持有连接或拼 SQL，会让业务逻辑与存储实现绑死——换存储、加缓存、
加读写分离都要回头改业务代码，而散落在业务代码里的 SQL 通常没人敢动。

**✅ 正例**

```ts
@Injectable()
export class UserService {
  constructor(private readonly userRepo: UserRepository) {}

  async findOne(id: string): Promise<UserResponseDto> {
    const user = await this.userRepo.findById(id);
    if (!user) {
      throw new NotFoundException({ code: 21101, message: '用户不存在' });
    }
    return this.toResponse(user);
  }
}
```

**❌ 反例**

```ts
@Injectable()
export class UserService {
  constructor(private readonly dataSource: DataSource) {}   // 直接持有连接

  async findOne(id: string) {
    return this.dataSource.query(
      `SELECT * FROM users WHERE id = '${id}'`,   // 拼 SQL：绑死存储，且引入注入风险
    );
  }
}
```

> 裸 SQL 本身的边界见 **LAYER-09**：只读行锁例外放行，裸写绝对禁止。

### LAYER-05 `[必须]` 依赖只用构造函数注入，禁止 `new` 服务、禁止服务定位器

**为什么**：手工 `new` 出来的实例不在容器里——它拿不到注入的依赖、用不到测试替身、
也无法参与生命周期管理。代价在测试时兑现：你会被迫为一次单元测试启动整个依赖链。

**✅ 正例**

```ts
@Injectable()
export class UserService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly mailService: MailService,
  ) {}
}
// 测试时可在模块中把这两个依赖替换为替身
```

**❌ 反例**

```ts
// 反例一：手工 new，依赖在构造时写死，测试无法替换
const mailService = new MailService(new SmtpClient());

// 反例二：服务定位器，把依赖关系藏进运行时而非签名
const mailService = this.moduleRef.get(MailService, { strict: false });
// 读构造函数不再能知道这个类依赖什么
```

### LAYER-06 `[禁止]` 跨模块不得直接引用对方内部实现，必须经对方模块导出的接口

**为什么**：直接引用别的模块的内部文件，会建立一条**模块图上不存在的依赖边**。
对方重构内部结构时不会有任何提醒，你的失败形式是编译错误或启动时的注入报错——
而不是"这个能力我对外承诺过"的评审讨论。

**✅ 正例**

```ts
// user.module.ts —— 显式声明对外提供的能力
@Module({
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}

// order.module.ts —— 经模块导入，再构造注入
@Module({ imports: [UserModule] })
export class OrderModule {}
```

**❌ 反例**

```ts
// order.service.ts —— 绕过 exports，直接深入对方目录引用内部实现
import { UserRepository } from '../user/user.repository';
import { toUserResponse } from '../user/user.mapper';
// 这两处都不在 UserModule 的 exports 中。对方重构时：
// 轻则编译失败，重则运行时注入报错——都发生在对方已经合并之后
```

### LAYER-07 `[推荐]` `src/` 下先按分区组织，`modules/` 下才是一个业务模块一个目录，DTO 放模块内 `dto/` 子目录

**为什么**：按技术类型平铺（`controllers/`、`services/`、`dtos/`）会让"改一个功能"需要跳几个目录；
按业务模块聚合则让一次改动的范围收敛在一个目录内，评审的 diff 也更集中。
但只有聚合还不够——业务模块与基础设施（配置、公共设施、外部依赖封装）混在 `src/` 同一层时，
目录一多就分不清哪些是"业务"、哪些是"地基"，而这两类目录的修改风险与评审要求并不相同。
所以先用一层分区目录把两者分开，再在 `modules/` 内按业务聚合。

分区目录按需增设，常见的几类是 `config`、`common`、`infra`、`migration`；
分区名由项目统一约定，一经确定不再随意增删。

**✅ 正例**

```text
src/
  config/                 分区：配置读取与启动校验
  common/                 分区：公共设施（装饰器 / 守卫 / 过滤器 / 拦截器 / 公共 DTO）
  infra/                  分区：外部依赖封装（数据访问 / 缓存）
  modules/                分区：业务模块，以下一个目录一个域
    user/
      dto/
        create-user.dto.ts
        update-user.dto.ts
        query-user.dto.ts
        user-response.dto.ts
      user.controller.ts
      user.service.ts
      user.repository.ts
      user.mapper.ts
      user.module.ts
    role/
      ...
  main.ts
  app.module.ts
```

**❌ 反例**

```text
src/
  controllers/          // 反例一：按技术类型平铺
    user.controller.ts
    order.controller.ts
  services/
    user.service.ts
    order.service.ts
  dtos/
    user.dto.ts         // 多个模块的 DTO 挤在一个文件里
    order.dto.ts
```

```text
src/
  user/                 // 反例二：业务模块与基础设施平铺在同一层
  role/                 // 哪个是业务、哪个是地基，只能靠命名猜
  config/
  common/
  infra/
```

### LAYER-08 `[推荐]` 单文件超约 300 行、或单类职责超过一个时，拆分

**为什么**：文件长度是职责数量的代理指标。一个 800 行的 Service 通常在做四件事，
而"该把新方法加到哪个文件"这个问题，在文件变长之后就没有明显答案了。

拆分的具体信号：

- 类名里出现"和"/`And`（如 `UserAndPermissionService`）
- 需要滚动多屏才能读完一个类
- 方法数超过 10 个，且能按前缀（`checkXxx`、`buildXxx`）自然分成两组
- 测试文件需要多个 `describe` 块描述互不相关的行为

**✅ 正例**

```text
user/
  user.service.ts             // 用户主流程
  user-permission.service.ts  // 权限相关，独立职责
  user.mapper.ts              // 实体与 DTO 的转换
```

**❌ 反例**

```text
user/
  user.service.ts   // 820 行：增删改查 + 权限校验 + 邮件通知 + 数据导出
```

### LAYER-09 `[必须]` 裸 SQL 只许出现在数据访问层，且只许只读行锁一种；裸写在业务代码里绝对禁止

**为什么**：ORM 的查询扩展（软删除过滤、审计字段自动填充、写守卫）**不会**被裸 SQL 触发。
一旦业务代码里出现裸 `INSERT` / `UPDATE` / `DELETE`，这些守卫就被整条绕过——而绕过的地方不会报错，
只会悄悄少一次填充、少一次拦截。**只读行锁是唯一的例外**：`SELECT … FOR UPDATE` 不写任何行、
不碰守卫的路，且没有任何不带裸 SQL 的等价收法——用条件更新抢锁会顺带刷新修改时间，
唯一索引要建迁移，分布式锁不在事务语义里。

**允许的唯一形状**（四条全满足才允许）：

1. 语句是 **`SELECT … FOR UPDATE`**，只读，锁行不改行；
2. 位置在**数据访问层**（数据访问层内的仓储 / 查询对象），不在 Service / Controller；
3. 在事务里当**第一句**——锁后再做一致性读，否则「先查后判」的时间窗原样还在；
4. 用**参数化绑定**，不拼字符串。

**✅ 正例**

```ts
// 仓储内：事务第一句抢行锁，锁后再做一致性读
await tx.$queryRaw`SELECT id FROM mentor_profile WHERE id = ${profileId} FOR UPDATE`;
const inFlight = await tx.mentorApplication.count({
  where: { profileId, status: 2 },
});
```

**❌ 反例**

```ts
await tx.$executeRaw`UPDATE mentor_profile SET summary = ${summary} WHERE id = ${id}`;
// 裸写：审计列填充、软删除过滤、写守卫全部绕过，且不报错
```

**同步任务与迁移脚本不受本条约束**——它们本来就要绕过业务守卫。但**业务代码里的裸写没有任何例外**。

## 6. 异常与错误码

错误码编码规则：

```text
0            成功
10000-10999  通用（参数校验 / 鉴权 / 限流 / 系统）
20000-20999  认证 auth
21000-21999  用户 user
22000-22999  角色 role
23000-23999  权限 permission
24000-24999  部门 dept
25000-25999  数据字典 dict
26000-26999  系统配置 config
27000-27999  操作日志 log
28000-28999  文件 file
29000-29999  预留
```

通用段的具体码位：

```text
10000  服务器内部错误
10001  参数校验失败
10002  未认证
10003  无权限
10004  资源不存在
10005  请求过于频繁
10006  资源冲突
```

规则要点：全局唯一、按模块分段、集中定义在枚举中、新增需登记。
段位按模块分配完毕后登记在上表；新增模块须先登记取段，不得自行选段。
模块内部的码位编排由各模块自行决定，但不得越出自己的段。

### ERR-01 `[必须]` 业务失败必须抛出框架的 HTTP 异常家族或自定义业务异常，禁止裸 `throw new Error`

**为什么**：裸 `Error` 对框架而言是未预期异常，会被兜底成 500。业务失败与系统故障在监控上
从此无法区分——一个"用户名已存在"和一个"数据库连不上"看起来完全一样，前端的可重试判断
也失去了依据。

**✅ 正例**

```ts
throw new NotFoundException({ code: 21101, message: '用户不存在' });
throw new ConflictException({ code: 21102, message: '用户名已存在' });
throw new ForbiddenException({ code: 10003, message: '无权访问' });
```

**❌ 反例**

```ts
throw new Error('用户不存在');
// 框架不认它 → 兜底成 HTTP 500
// 监控上表现为"服务端错误率上升"，而实际上只是一个完全正常的业务分支
```

### ERR-02 `[必须]` 错误码集中定义（枚举 / 常量），禁止业务代码中出现裸数字码或魔法字符串

**为什么**：错误码是接口契约的一部分——前端要靠它判断分支。散落的裸数字无法被检索、无法被去重，
也无法回答"这个码还有没有在用"。

**✅ 正例**

```ts
export enum ErrorCode {
  // 通用 10000-10999
  INTERNAL_ERROR = 10000,
  PARAM_INVALID = 10001,
  UNAUTHORIZED = 10002,
  FORBIDDEN = 10003,
  NOT_FOUND = 10004,
  RATE_LIMITED = 10005,
  CONFLICT = 10006,

  // 用户模块 21000-21999
  USER_NOT_FOUND = 21101,
  USER_NAME_TAKEN = 21102,
}
```

**❌ 反例**

```ts
if (exists) {
  throw new ConflictException({ code: 21102, message: '用户名已存在' });
}
// 21102 在这里写死。想查"21102 还在哪些地方用"只能全局搜数字，
// 而搜 21102 会同时命中金额、ID、以及无关的字符串
```

### ERR-03 `[必须]` 错误码全局唯一、按模块分段，新增需登记

**为什么**：两个模块用同一个码，前端的错误分支就会串台——用户模块的文案会出现在订单流程里。
分段让"这个码属于谁"一眼可见，也避免新增时撞号。

**✅ 正例**

```ts
// 用户模块：21000-21999
USER_NOT_FOUND = 21101,

// 角色模块：22000-22999 —— 另一段，不重叠
ROLE_NOT_FOUND = 22101,
```

**❌ 反例**

```ts
// 两个模块各写各的，撞在同一个号上
// user.service.ts
throw new NotFoundException({ code: 21101, message: '用户不存在' });

// role.service.ts
throw new NotFoundException({ code: 21101, message: '角色不存在' });
// 前端按 21101 展示"用户不存在"，角色管理里就会显示错误的文案
```

### ERR-04 `[必须]` 全局异常过滤器兜底，输出与成功响应同构的错误体

**为什么**：错误响应若与成功响应形状不同，前端的统一解析逻辑恰恰会在失败分支上失效——
而那是最需要它可靠的时候。

**✅ 正例**

```jsonc
// 全局异常过滤器把任何异常归一化成与成功响应同构的外壳
{
  "code": 21101,
  "message": "用户不存在",
  "data": null,
  "traceId": "..."
}
```

**❌ 反例**

```ts
// 每个 Controller 自己 try/catch 拼错误响应
@Get(':id')
async findOne(@Param() params: UserParamDto) {
  try {
    return await this.userService.findOne(params.id);
  } catch (e) {
    return { error: true, msg: e.message };   // 形状与成功响应完全不同
  }
}
// 而漏写 try/catch 的那个 Controller，会直接吐出框架默认的错误页
```

### ERR-05 `[禁止]` 未捕获异常不得向客户端泄露堆栈、SQL、内部路径、依赖版本

**为什么**：这些信息对攻击者是免费的侦察资料——表结构、数据库类型与版本、项目目录、依赖版本，
足以显著降低针对性攻击的成本。而对正常用户，它们毫无价值。

**✅ 正例**

```ts
// 过滤器中对未预期异常统一收口：对外通用文案，对内保留原始信息
logger.error('unhandled exception', { traceId, stack: exception.stack });
response.status(500).json({
  code: 10000,
  message: '服务器内部错误',
  data: null,
  traceId,
});
```

**❌ 反例**

```ts
const message = `${error.message}\n${error.stack}`;
return { code: 10000, message, data: null };
// 客户端拿到：
//   PrismaClientKnownRequestError: Table 'app.user_account' does not exist
//     at PrismaClient._request (.../node_modules/...)
//     at /app/src/modules/user/user.repository.ts:42:11
// 一次响应就把表名、存储类型、目录结构、行号全部交出
```

### ERR-06 `[必须]` 参数校验失败的错误响应必须能定位到具体字段

**为什么**：只说"参数错误"，前端和联调方无法知道该改哪个字段。一次请求只能暴露一个问题，
排查会退化成多次往返。字段级错误本就是校验管道的天然输出，没有理由丢掉。

**✅ 正例**

```jsonc
{
  "code": 10001,
  "message": "参数校验失败",
  "data": {
    "fields": [
      { "field": "name", "message": "长度不能少于 2 个字符" },
      { "field": "email", "message": "不是合法的邮箱地址" }
    ]
  }
}
```

**❌ 反例**

```jsonc
{ "code": 10001, "message": "参数错误", "data": null }
// 前端只能猜是哪个字段；多个字段出错时要一轮一轮试出来
```

### ERR-07 `[禁止]` 禁止 `catch` 后静默吞掉异常，或返回 `null` 掩盖失败

**为什么**：被吞掉的异常会让故障表现为"数据莫名不对"而不是"接口报错"。后者会有人报警，
前者往往在几天后才被发现——而那时已经无法从日志还原当时发生了什么。

**✅ 正例**

```ts
async findOne(id: string): Promise<UserResponseDto> {
  const user = await this.userRepo.findById(id);
  if (!user) {
    throw new NotFoundException({ code: 21101, message: '用户不存在' });
  }
  return this.toResponse(user);
}
```

**❌ 反例**

```ts
// 反例一：完全吞掉
try {
  await this.mailService.sendWelcome(dto.email);
} catch (e) {
  // 什么都不做：用户没收到邮件，且没有任何记录留下
}

// 反例二：用 null 掩盖失败
try {
  return await this.userRepo.findById(id);
} catch (e) {
  return null;   // 调用方无法区分"没找到"与"查询失败"
}
```

### ERR-08 `[推荐]` 记录异常时保留原始堆栈与业务上下文，用 `traceId` 串联

**为什么**：日志里只有一句"用户不存在"是没有用的——它无法回答"是哪个请求、哪个用户、
传了什么参数导致的"。上下文与 `traceId` 是把日志还原成事件的关键。

**✅ 正例**

```ts
logger.error('创建用户失败', {
  traceId,
  operatorId: currentUser.id,
  payload: { name: dto.name, email: dto.email },
  err: error.stack,
});
```

**❌ 反例**

```ts
logger.error(error.message);
// 或更糟：
console.log('出错了');
// 无法定位是哪个请求、哪个用户、什么参数
```

## 7. 命名与文件组织

### NAME-01 `[必须]` 文件 kebab-case 带角色后缀

**为什么**：文件名是唯一会出现在 `import` 语句里的名字。大小写风格不统一时，在区分大小写的
文件系统上能跑、换到不区分的环境就会失败——而这类失败通常发生在部署那一刻，本地永远复现不了。

**✅ 正例**

```text
user.controller.ts
user.service.ts
user.module.ts
create-user.dto.ts
user-response.dto.ts
```

**❌ 反例**

```text
UserController.ts      // PascalCase 文件名
user.Controller.ts     // 角色后缀大小写不一致
userController.ts      // camelCase 文件名
user_service.ts        // 下划线分词
```

### NAME-02 `[必须]` 类 PascalCase、方法与变量 camelCase、常量 UPPER_SNAKE_CASE；私有成员不加下划线前缀

**为什么**：下划线前缀在 TypeScript 里没有语义作用（有 `private` 关键字承担），
却会让同一份代码里出现两种风格——读的时候需要额外判断这个下划线是不是有含义。

**✅ 正例**

```ts
export class UserService {
  private readonly MAX_RETRY = 3;   // 常量：UPPER_SNAKE_CASE

  constructor(private readonly userRepo: UserRepository) {}   // 私有成员无下划线前缀

  async findActiveUser(userId: string): Promise<UserEntity> { /* ... */ }
}
```

**❌ 反例**

```ts
export class user_service {        // 类名不是 PascalCase
  private _userRepo;               // 下划线前缀
  private maxRetry = 3;            // 常量用了小驼峰

  async FindActiveUser(UserId) { } // 方法 PascalCase、参数 PascalCase
}
```

### NAME-03 `[必须]` 路由路径小写、中划线分词、资源用复数

**为什么**：路由是接口契约的一部分，也是文档里给前端看的第一行。动词进路径会把"操作"
和"资源"混在一起——同一个资源上的不同操作会散落在毫无关联的路径前缀下。

**例外**：指向「当前登录者自身」的单一资源用单数，因为它没有复数语义——
`GET /auth/profile`、`GET /users/me` 是合规的。除这类"当前用户标识"外，
其余指向集合的路径一律用复数。

**✅ 正例**

```ts
@Controller('users')            // GET /users、POST /users、GET /users/:id
@Controller('user-groups')      // 多词用中划线分词

@Get('profile')                 // 例外：当前登录者自身，无复数语义
```

**❌ 反例**

```ts
@Controller('User')          // 大写
@Controller('getUserList')   // 动词进路径
@Controller('user_group')    // 下划线分词
@Controller('user')          // 单数
```

### NAME-04 `[推荐]` 布尔值用 `is` / `has` / `can` / `should` 前缀，禁止否定式命名

**为什么**：否定式命名在读条件判断时会产生双重否定。`if (!isNotDeleted)` 需要停顿一下才能想明白，
而这种停顿在每次读到它时都会发生。

**✅ 正例**

```ts
isActive: boolean;
hasPermission: boolean;
canEdit: boolean;
shouldNotify: boolean;
```

**❌ 反例**

```ts
isNotDeleted: boolean;
if (!isNotDeleted) { /* 双重否定 */ }

disableFlag: boolean;   // 从命名看不出 true 代表什么
flag: boolean;
```

### NAME-05 `[禁止]` 禁止使用 `any`

**为什么**：`any` 会沿调用链传播——一个 `any` 参数会让函数体失去全部类型保护，返回值再变成
`any` 继续往下传，保护逐层剥落。而且它是静默的：字段名拼错不会报错，要到运行时才暴露。

本条曾定为 `[推荐]`，因为项目早期的 ESLint 配置未启用 `no-explicit-any`，而一条无人执行的
条款会稀释其余条款的严肃性——那是一次有明确升级路径的临时降级。**ESLint 现已收紧为 error，
本条随之升级为 `[禁止]`，降级理由不再成立。**

确实无法确定类型时用 `unknown` 替代，并在就地注释里说明原因与边界——`unknown` 强制你在使用前
收窄类型，`any` 则什么都不要求。

**✅ 正例**

```ts
function handleEvent(event: UserCreatedEvent): void { /* ... */ }

// 确实无法确定类型时，用 unknown 而不是 any，并就地说明原因与边界
function parseLegacyPayload(
  raw: unknown,   // 旧版接口返回结构无类型定义，见 ADR-012
): UserEntity { /* ... */ }
```

**❌ 反例**

```ts
function handleEvent(event: any) {
  // event 的任何字段访问都不受保护，字段名拼错也不会报错
  return event.userName;   // 实际字段名是 name，要到运行时才发现
}
```

### NAME-06 `[推荐]` 避免缩写，领域通用缩写（`id` / `url` / `http` / `dto`）除外

**为什么**：缩写的可读性取决于读者是否恰好知道那个约定。`usrId` 省下 3 个字符，
代价是每次有人读它都要先解码一次——而这个成本会乘以团队人数。

**✅ 正例**

```ts
userId: string;
userName: string;
message: string;
emailAddress: string;
temporaryData: object;
```

**❌ 反例**

```ts
usrId: string;
userNm: string;
msg: string;
emlAddr: string;
tmpData: object;
```

## 8. 数据表与审计字段

所有会变更的数据都必须是可追溯的：谁在什么时候创建了它、谁在什么时候最后一次改了它。
本章把这个要求固化进表结构，而不是依赖某个人的自觉——因为"记得写"不是一种机制。

### DB-01 `[必须]` 所有业务表必须包含四个审计字段：创建时间、修改时间、创建人、最新修改人

**为什么**：这四个字段是事后追责与数据修复的唯一依据。它们必须建在表上——等到真正需要的时候
再补，补上的只能是"从今天起"的记录，而之前的历史永远丢失。

**✅ 正例**

```sql
CREATE TABLE user_account (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(50)     NOT NULL,
  email       VARCHAR(255)    NOT NULL,

  created_at  DATETIME(3)     NOT NULL,
  updated_at  DATETIME(3)     NOT NULL,
  created_by  BIGINT UNSIGNED NOT NULL,
  updated_by  BIGINT UNSIGNED NOT NULL
);
```

**❌ 反例**

```sql
CREATE TABLE user_account (
  id     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name   VARCHAR(50)     NOT NULL,
  email  VARCHAR(255)    NOT NULL
);
-- 出问题时无法回答：这条数据什么时候进来的、有没有被人改过、谁改的
-- 事后补字段只能补上"从今天起"的记录，之前的历史永久丢失
```

### DB-02 `[必须]` 数据库列名统一为 `created_at` / `updated_at` / `created_by` / `updated_by`；代码内实体属性用 camelCase 对应

**为什么**：这四个字段会出现在几乎每张表上。命名不统一时，每次写查询都要先确认这张表用的是
哪套风格——这种确认是纯粹的浪费，并且每张新表都会重复一次。

**✅ 正例**

```sql
-- 数据库：下划线风格，全局统一
created_at  DATETIME(3)     NOT NULL,
updated_at  DATETIME(3)     NOT NULL,
created_by  BIGINT UNSIGNED NOT NULL,
updated_by  BIGINT UNSIGNED NOT NULL
```

```ts
// 代码内实体属性用 camelCase，与列名一一对应
class UserEntity {
  createdAt: Date;    // → created_at
  updatedAt: Date;    // → updated_at
  createdBy: bigint;  // → created_by
  updatedBy: bigint;  // → updated_by
}
// 两者之间的映射由全局命名策略统一处理，不在单个实体上手工指定
```

**❌ 反例**

```sql
-- 同一套系统里三种风格并存
create_time  TIMESTAMP NOT NULL,   -- 表 A
gmt_create   DATETIME  NOT NULL,   -- 表 B
createdAt    TIMESTAMP NOT NULL    -- 表 C
```

### DB-03 `[必须]` 时间字段必须无时区歧义（库内存 UTC）；创建时间写入后不可变，修改时间每次更新自动刷新

**为什么**：时间一旦带有时区歧义，审计记录就无法解释——你不知道那个"14:30"是哪个时区的 14:30。
审计的价值完全依赖于时间可被无歧义地解释。本项目约定：**库里一律存 UTC**，
且写入端与默认值必须都从 UTC 源产出，不能依赖数据库会话时区。

**✅ 正例**

```sql
-- 存 UTC。默认值用 UTC_TIMESTAMP(3) 而不是 CURRENT_TIMESTAMP(3)：
-- 后者按会话时区求值，默认是服务器本地时区，与"库内存 UTC"的约定直接冲突
created_at  DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
updated_at  DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3))   -- 每次更新时刷新
```

**❌ 反例**

```sql
-- 反例一：用字符串存时间
created_at  VARCHAR(20) NOT NULL

-- 反例二：默认值用会话时区的 CURRENT_TIMESTAMP
updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
-- 本意是"写入当前时间"，实际写入的是服务器本地时区的时间；
-- 而读取端按"库内存 UTC"的约定去解释它 —— 8 小时偏差，
-- 且只在没走应用层写入的数据上出现，是最难查的一类不一致
```

### DB-04 `[必须]` 创建人 / 最新修改人存操作者用户标识，与鉴权主体一致；系统自动任务写约定的系统标识，不留空

**为什么**：若存的是用户名，用户改名之后所有历史审计记录都会指向一个"现在不存在"的名字——
而审计的意义恰在于多年后回看，那正是改名最可能已经发生的时刻。系统任务留空，则会让
"这条数据到底是谁写的"永远无解。

**✅ 正例**

```sql
-- 存用户标识：与鉴权主体一致的稳定 ID，而不是用户名
created_by  BIGINT UNSIGNED NOT NULL,
updated_by  BIGINT UNSIGNED NOT NULL

-- 系统自动任务写入约定的系统标识，而不是留空：
--   约定用 0。自增主键从 1 开始，0 永远不会与真实用户冲撞，
--   因此 0 可以无歧义地表示"由系统任务创建"
```

**❌ 反例**

```sql
-- 存用户名：用户改名后，历史记录指向一个再也查不到的名字
created_by  VARCHAR(50) NOT NULL   -- 例如 '张三'

-- 或者允许为空：永远无法区分"系统写的"与"当时忘了填"
created_by  BIGINT UNSIGNED NULL
```

### DB-05 `[必须]` 四个字段由数据访问层统一自动填充，禁止在 Service 中手写赋值

**为什么**：手写赋值意味着每一处写操作都要记得写四行，而"记得"不是机制。
漏掉的那一处会产生一条无审计的数据，且不会报任何错——只有在真正需要追溯时才会暴露。

**✅ 正例**

```ts
// 数据访问层统一填充，业务代码完全不感知
class AuditableEntity {
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
}
// 创建与更新时，由数据访问层从当前请求上下文取操作者并写入这四个字段
```

**❌ 反例**

```ts
// Service 里逐处手写
async create(dto: CreateUserDto, operatorId: string) {
  return this.userRepo.save({
    ...this.toEntity(dto),
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: operatorId,
    updatedBy: operatorId,
    // 而在批量导入那处忘了写这四行 ——
    // 无审计的数据从此存在，且没有任何提示
  });
}
```

### DB-06 `[禁止]` 业务代码不得修改创建时间与创建人

**为什么**：创建信息一旦可改，它就不再是证据。一条被改过的 `created_at` 与一条原本就填错的
`created_at` 在事后无法区分——这让所有审计字段的可靠性一起归零。

**✅ 正例**

```ts
// 更新只触碰业务字段，审计字段交给数据访问层处理
await this.userRepo.update(id, { name: dto.name, email: dto.email });
```

**❌ 反例**

```ts
await this.userRepo.update(id, {
  name: dto.name,
  created_at: new Date(),   // 覆盖了创建时间
  created_by: operatorId,   // 覆盖了创建人
});
```

### DB-07 `[推荐]` 纯追加表（只写不改的日志 / 流水表）可只保留创建时间与创建人

**为什么**：这类表没有"修改"这个动作。硬塞 `updated_at` / `updated_by` 会带来两个问题：
每次插入都要为两个永远等于创建值的字段赋值；更重要的是，它们会被误读为"这张表是可以改的"。

**✅ 正例**

```sql
-- 操作日志表：只追加，不修改
CREATE TABLE operation_log (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  action      VARCHAR(50)     NOT NULL,
  payload     TEXT,

  created_at  DATETIME(3)     NOT NULL,
  created_by  BIGINT UNSIGNED NOT NULL
  -- 无 updated_at / updated_by：这张表不存在"更新"这个动作
);
```

**❌ 反例**

```sql
CREATE TABLE operation_log (
  ...
  created_at  DATETIME(3)     NOT NULL,
  created_by  BIGINT UNSIGNED NOT NULL,
  updated_at  DATETIME(3)     NOT NULL,   -- 永远等于 created_at，是噪音
  updated_by  BIGINT UNSIGNED NOT NULL    -- 同上，且暗示这张表可以被改
);
```

### DB-08 `[推荐]` 表名与字段名风格由全局命名策略统一切换，不在单个表上手写混用

**为什么**：风格统一的价值在于"不需要记忆"。一旦允许单表例外，每读一张不熟悉的表都要先确认
它用了哪套风格——例外越多，这条规则提供的确定性越少，直到归零。

**✅ 正例**

```text
# 全局下划线风格：表名小写下划线、列名小写下划线
user_account
user_login_record
```

**❌ 反例**

```text
# 同一套系统里混用
user_account        # 下划线
UserLoginRecord     # PascalCase 表名
userGroup           # camelCase 表名

# 甚至同一张表内混用：user_name（下划线）与 userAge（小驼峰）并存
```

### DB-09 `[必须]` 需要软删除的表用 `deleted_at` / `deleted_by` 标记，禁止用布尔标志位

**为什么**：布尔标志位只回答"删没删"，不回答"什么时候删的"。而"什么时候删的"是排查
"这条数据为什么不见了"时唯一有用的信息——只有标志位时，你无法区分它是三个月前被正常
停用的，还是一分钟前被一段出错的代码误删的。时间戳一列同时承载这两个信息，
存储代价与布尔位完全相同。

**默认过滤**：业务查询默认只返回未删除数据。确需查询已删除数据时必须显式声明
（独立的查询参数或独立的方法名），不得依赖"碰巧没写过滤条件"而偶然返回已删除行。

**✅ 正例**

```sql
-- 可空时间戳：NULL 表示未删除，非空即删除时刻
deleted_at DATETIME(3) NULL,
deleted_by BIGINT UNSIGNED NULL
```

**❌ 反例**

```sql
is_deleted TINYINT(1) NOT NULL DEFAULT 0
-- 想回答"什么时候删的、谁删的"，只能在表里已经有数据之后再加两列，
-- 而那些列上没有历史值可回填 —— 补不回来了
```

### DB-10 `[必须]` 连接表（两表关联）用物理删除，不用软删除

**为什么**：连接表的唯一约束通常是两列的组合，而软删除保留行、唯一约束仍然生效，
于是"撤销授权后重新授予"这个再普通不过的操作会撞唯一约束而失败。失败信息是
"记录已存在"，与它实际的语义（已撤销的旧授权占着位）毫无关系，排查成本极高。
撤销关联本身也不承载审计价值——谁在何时授过权，看该行的创建字段即可，撤销后的空行不必留。

**✅ 正例**

```text
用户角色关联表：撤销角色 = 删除该行
重新授予同一角色 = 重新插入同一组合，不冲突
```

**❌ 反例**

```text
用户角色关联表也做软删除：
  授予角色 → 插入 (1001, 3)
  撤销角色 → 标记 deleted_at
  再次授予 → 插入 (1001, 3) → 唯一约束冲突，操作失败
```

### DB-11 `[必须]` 软删除表上的唯一约束必须排除已删除行

**为什么**：软删除保留了行，唯一约束就仍然被这些行占用。一个已离职员工的登录名会让
新员工无法使用同一登录名，而报错是"该名称已存在"——管理员在界面上看不到任何同名的
现有记录，只能反复重试。这是软删除引入后最常见的功能性故障。

**✅ 正例**

```sql
-- 生成列：未删除时取真实值，已删除时为 NULL；
-- NULL 不参与唯一性比较，于是唯一性只约束未删除的行
ALTER TABLE sys_user
  ADD COLUMN username_active VARCHAR(50)
    GENERATED ALWAYS AS (IF(deleted_at IS NULL, username, NULL)) VIRTUAL,
  ADD UNIQUE KEY uk_sys_user_username_active (username_active);
```

**❌ 反例**

```sql
-- 唯一索引直接建在业务列上，已删除行仍占位
UNIQUE KEY uk_sys_user_username (username)
-- 已软删除的 zhangsan 占着这个名字，新员工 zhangsan 永远建不进来
```

## 9. 接口文档

接口文档由代码中的注解自动生成，直接面向前端开发者。本章规定两件事：
注解必须写到什么程度，以及"覆盖式更新"如何成立。

### DOC-01 `[必须]` 接口文档由代码注解自动生成，禁止手工编写或手工编辑生成产物

**为什么**：手工维护的文档必然漂移——不是因为它难写，而是因为改代码时没有任何机制提醒你同步改它。
由注解生成，把"文档是否最新"这个问题转化成了"注解是否最新"，而后者就写在代码里，评审时看得见。

**✅ 正例**

```ts
// 文档的唯一来源是代码注解
@ApiTags('用户管理')
@ApiOperation({ summary: '创建用户' })
@Post()
async create(@Body() dto: CreateUserDto): Promise<UserResponseDto> { /* ... */ }
```

**❌ 反例**

```text
docs/api/user.md   ← 手工维护的接口文档

  创建用户
  POST /users
  参数：name, email, age     ← age 字段两年前就删了，没有人记得改这里
```

### DOC-02 `[必须]` 生成产物整体覆盖，不追加、不手工修补（即"覆盖式更新，非增量式更新"）

**为什么**：一旦允许在生成产物上手改，文档就同时有了两个来源——生成器与人工。下次生成时人工内容
被冲掉，而且不会有人知道曾经有过这段内容。历史版本由 Git 保存，文档正文只描述当前状态。

**✅ 正例**

```bash
# 生成命令直接覆盖产物文件，产物作为构建输出，不手工编辑（脚本名以实际选型为准）
pnpm run docs:generate   # 整体覆盖 docs/api/openapi.json
```

**❌ 反例**

```text
在生成出来的文档里手动插入一段"注意事项：本接口暂不支持批量"。
下次生成即消失，且没有任何机制会提醒编写者它消失了。
```

### DOC-03 `[必须]` 文档随构建 / 发布流程重新生成，保证文档与代码同版本

**为什么**：文档与代码不同版本时，前端会按错误的契约开发——而这个错误要到联调才暴露，
那时前端已经按旧契约把页面写完了。

**✅ 正例**

```bash
# 在构建/发布流程中固定执行（脚本名以实际选型为准）
pnpm run build
pnpm run docs:generate
```

**❌ 反例**

```text
文档是上个月生成的，代码这一个月改了 20 个接口。
前端按文档开发完毕，联调时才发现字段名、必填项、路径全都对不上。
```

### DOC-04 `[必须]` 每个接口必须有注解声明：接口名称、功能说明、所属分组

**为什么**：只有路径和字段的文档，前端无法判断该在什么场景下调用它。功能说明是前端唯一能
据以判断"这个接口是不是我要找的"的信息。

**✅ 正例**

```ts
@ApiTags('用户管理')   // 分组
@ApiOperation({
  summary: '创建用户',
  description: '管理员在后台新增一个用户账号，初始状态为待激活。',
})
@Post()
async create(@Body() dto: CreateUserDto): Promise<UserResponseDto> { /* ... */ }
```

**❌ 反例**

```ts
@Post()
async create(@Body() dto: CreateUserDto): Promise<UserResponseDto> { /* ... */ }
// 文档里只有一行 "POST /users"，没有任何说明。前端只能去问：
// 这个接口是给后台用的还是给 C 端用的？创建出来的账号会直接生效吗？
```

### DOC-05 `[必须]` 请求 DTO 每个字段必须有注解：类型、是否必填、含义、示例值；枚举字段列出全部可选值

**为什么**：字段含义是文档最核心的信息。"类型 + 必填"只说明了格式，没有说明这个字段在业务上
是什么、该填什么。示例值则是把含义落地成具体输入的最短路径。

**✅ 正例**

```ts
export class CreateUserDto {
  @ApiProperty({ description: '用户真实姓名，会显示在个人主页', example: '张三' })
  @IsString() @Length(2, 20)
  name: string;

  @ApiProperty({
    description: '账号角色，决定可访问的功能范围',
    enum: UserRole,
    enumName: 'UserRole',
    example: UserRole.Guest,
  })
  @IsEnum(UserRole)
  role: UserRole;

  @ApiProperty({ description: '备注，可留空', required: false, example: '由 admin 于 10 月创建' })
  @IsOptional() @IsString()
  remark?: string;
}
```

**❌ 反例**

```ts
export class CreateUserDto {
  @ApiProperty()
  @IsString() @Length(2, 20)
  name: string;

  @ApiProperty({ type: 'string' })
  @IsEnum(UserRole)
  role: UserRole;
}
// 文档里 role 只写着 "string"：前端不知道有哪些合法值
// name 除"必填"外没有任何信息：是姓名？昵称？还是登录用户名？
```

### DOC-06 `[必须]` 响应 DTO 每个字段必须有注解：类型、含义、是否可能为空

**为什么**：前端要按响应字段写渲染逻辑，"这个字段可能为空吗"直接决定要不要写兜底分支。
缺了这项，前端只能按最坏情况处理，或者等线上出问题再补。

**⚠️ 可空字段必须显式写 `type`（批次一实测补充）**：声明成 `X | null` 的字段，TypeScript 的运行时
类型元数据（`design:type`）是 `Object` 而不是 `String`。**只写 `nullable: true` 而不写 `type`，
生成的 schema 会是 `{"type":"object","nullable":true}`** —— 文档于是**说了假话**：前端按它生成类型
会拿到 `object`，赋字符串在编译期就报错，运行时真塞对象则炸在解析处。
`X | undefined`（可选字段 `x?: X`）**不受影响**，能正常推断成 `X`——**只有 `| null` 会掉进这个坑**。

**规则：任何 `X | null` 的字段，`@ApiProperty` 里都要显式写 `type`。**
这个错误**不会让任何门禁变红**：`pnpm build` 过、测试全绿、文档照常生成——只有打开 JSON 看
`schemas` 才能发现，与「响应 schema 整体缺失」（发现 37）是同一类静默退化。
批次一踩过一次：`DeptResponseDto.parentId` / `.remark`、`CreateDeptDto.parentId`（见**发现 40**）。

> **正例里的注释只写一行，机制留在本条正文。** 正例是会被整段抄进源码的那一份——
> 把机制写进正例的注释，它就会在每个可空字段旁边重复 5 行。机制讲一次就够，指回来。

**✅ 正例**

```ts
export class UserResponseDto {
  @ApiProperty({ description: '用户唯一标识', example: '8f3a1c2e-...' })
  id: string;

  @ApiProperty({ description: '用户真实姓名', example: '张三' })
  name: string;

  // `type: String` 必须写（`| null` 的 design:type 是 Object）——机制见本条正文。
  @ApiProperty({
    description: '最近一次登录时间；从未登录过时为 null',
    type: String,
    nullable: true,
    example: null,
  })
  lastLoginAt: string | null;
}
```

**❌ 反例**

```ts
export class UserResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  lastLoginAt: string | null;
}
// 前端看到 lastLoginAt 是 string，直接 new Date(lastLoginAt)，
// 从未登录过的用户会让页面显示 Invalid Date
```

### DOC-07 `[必须]` 每个接口至少给出一个成功响应示例与一个典型失败响应示例

**为什么**：没有失败示例时，前端无法预判失败分支的形状与常见错误码——而失败分支恰恰是最容易
写错、也最难在开发阶段发现的部分。只在成功路径上联调，问题会全部留到线上。

**示例里必须是完整外壳**：`{ code, message, data }`，失败时 `data` 为 `null`。少了 `data` 的
示例会让前端漏掉兜底分支的字段，形状就不完整了。**但禁止逐接口重排这套外壳样板**（见
**DOC-13**）——抽成一个一行式帮助函数，每个接口只写一次调用。

**✅ 正例**

```ts
// 项目内提供一次（放 common/ 之类的文档注解帮助模块），全项目共用
export const errExample = (code: number, message: string) => ({
  code,
  message,
  data: null,
});

// 每个接口只写这一行调用——外壳不重排
@ApiOkResponse({ description: '创建成功', type: UserResponseDto })
@ApiConflictResponse({
  description: '用户名已存在',
  schema: { example: errExample(ErrorCode.USER_NAME_TAKEN, '用户名已存在') },
})
@Post()
async create(@Body() dto: CreateUserDto): Promise<UserResponseDto> { /* ... */ }
```

**❌ 反例**

```ts
@Post()
async create(@Body() dto: CreateUserDto): Promise<UserResponseDto> { /* ... */ }
// 文档里只有成功响应。前端不知道重名时返回什么形状、该提示什么文案
```

### DOC-08 `[必须]` 注解与代码在同一次提交内更新，禁止"先合并代码、下个迭代补注解"

**为什么**：文档的价值完全建立在"它与代码一致"之上。允许延后补注解，就等于允许文档在一段时间内
必然说谎——而这段"一段时间"通常会比预期长得多。

**✅ 正例**

```text
同一次提交：字段改名 + 注解更新一并完成
  src/user/dto/create-user.dto.ts
    name → realName（注解中的 description / example 同步修改）
```

**❌ 反例**

```text
PR #41  用户字段改名为 realName
评审意见："注解下个迭代统一补"
→ 此后一整个迭代里，文档都在告诉前端字段叫 name
```

### DOC-09 `[禁止]` 接口下线即删除其注解与文档，禁止注释保留"以后再删"

**为什么**：被注释掉的接口仍然留在源码里造成困惑，而前端无法从文档上区分"这个接口还能用"
和"这个接口已经废了"。下线这件事必须是原子的。

**✅ 正例**

```text
整个 Controller 及其 DTO 一并删除，同一次提交完成。
Git 历史里仍然能找回它，不需要靠注释保留。
```

**❌ 反例**

```ts
// @ApiTags('旧版用户接口')
// @Controller('v1/users')
// export class LegacyUserController { /* ... */ }
// 以后可能还要恢复
// 结果：半年后没人知道这段代码到底能不能删，文档里也还挂着这些接口
```

### DOC-10 `[推荐]` 字段说明用业务语言，不写"内部字段"这类无信息量描述

**为什么**：说明的价值在于它承载了代码本身读不出的信息。"内部字段""其他""保留字段"这类描述
占用了文档的位置却什么也没说——读的人仍然必须去问写的人。

**✅ 正例**

```ts
@ApiProperty({
  description: '订单支付截止时间，超时后订单自动关闭',
  example: '2026-10-08T14:30:00+08:00',
})
expiresAt: string;
```

**❌ 反例**

```ts
@ApiProperty({ description: '内部字段' })
expiresAt: string;

@ApiProperty({ description: '其他' })
extra: object;
```

### DOC-11 `[推荐]` 认证方式、统一响应外壳（RES-01）、错误码表（ERR-02）在文档全局说明中统一描述，不逐接口重复

**为什么**：这些内容对所有接口都相同。逐个接口重复描述，既让文档体积膨胀，又制造了
"N 处需要同步修改"的隐患——而它们本可以只写一次。

> 本条管的是**文档正文里的文字**不要逐接口重复。**代码里**逐接口重排响应外壳样板是另一回事，
> 已升为硬禁止——见 **DOC-13**。

**✅ 正例**

```text
文档全局说明（写在首页，不逐接口重复）：
  - 认证：所有接口需在请求头携带 Authorization: Bearer <token>
  - 响应外壳：{ code, message, data }，成功时 code 为 0（见 RES-01）
  - 业务错误码表：10002 未认证 / 10003 无权限 / 21101 用户不存在 / ...（见 ERR-02）
```

**❌ 反例**

```text
每个接口的文档里都重复一遍：
  "本接口需在请求头携带 Authorization: Bearer <token>"
  "响应格式为 { code, message, data }"
  ...
→ 20 个接口就有 20 处需要同步修改
```

### DOC-12 `[推荐]` 变更历史单独维护在变更记录文件中，不混入接口文档正文

**为什么**：接口文档回答"现在是什么"，变更历史回答"过去变成了什么"。把后者混进前者，
会让每次生成都把历史内容冲掉（见 DOC-02），或迫使生成产物重新变成手工维护——两者都不可接受。

> DOC-02 要求接口正文覆盖式更新，本条要求变更历史另存他处，两者并不矛盾：
> 它们本就是两类信息，分处两个文件即可各自保持自己的更新方式。

**✅ 正例**

```text
docs/api/        接口文档，每次构建整体覆盖
CHANGELOG.md     变更历史，人工追加，只增不改
```

**❌ 反例**

```text
docs/api/README.md   ← 同一个文件里既放接口列表，又放变更记录

  接口列表
    GET  /users
    POST /users

  变更记录
    - 2026-10-08 删除 /users/age 字段
    - 2026-09-21 新增 /users/export

→ 每次生成接口部分，都会把下面的变更记录一并覆盖掉
```

### DOC-13 `[禁止]` 禁止逐接口重排响应外壳样板

**为什么**：外壳 `{ code, message, data }` 对所有接口都相同（RES-01）。**示例里必须保留完整
外壳（含 `data: null`）**——那是契约的一部分；但那份样板只该被**写一次**。逐接口手写一遍：
源码体积与读写成本随接口数线性增长，而且 N 处需要同步修改——外壳加一个字段、错误码换一段
取值，就要改 N 个装饰器，漏一处就是静默的文档不一致。

**✅ 正例**

```ts
// 项目内提供一次（与 DOC-07 同一个帮助函数）
export const errExample = (code: number, message: string) => ({
  code,
  message,
  data: null,
});

// 多个失败原因并列时同理：oneOf 的每一项也只写一次调用
export const errExamples = (...pairs: Array<[number, string]>) =>
  pairs.map(([code, message]) => errExample(code, message));

@ApiConflictResponse({
  description: '用户名已存在',
  schema: { example: errExample(ErrorCode.USER_NAME_TAKEN, '用户名已存在') },
})
```

**❌ 反例**

```ts
@ApiConflictResponse({
  description: '用户名已存在',
  schema: {
    example: {
      code: ErrorCode.USER_NAME_TAKEN,
      message: '用户名已存在',
      data: null,
    },
  },
})
// 20 个接口就是 20 处；外壳加一个字段就要改 20 次，漏一处文档就说谎
```

> 注意边界：本条禁止的是**源码里重复铺设外壳样板**，不是禁止给示例补全外壳。
> 补全外壳是 DOC-07 的硬要求；重排样板才是本条禁止的。两者不冲突——用帮助函数即可同时满足。

## 附录 A 评审速查清单

评审时按此表逐项确认。每条均可追溯到正文对应条款，细节与代码示例见正文。

本表**手工维护**：新增或改动正文条款时，同一次改动里把对应的条目补上/改掉。
它曾声称「由正文自动抽取生成」，但从来没有那个脚本——一句没有机制支撑的声称
比没有说明更糟，读者会以为可以不核对它。**读这张表的人请当作它可能滞后于正文，
拿不准时以正文为准。**

- [ ] FLOW-01 动手写 Controller 之前，先写出该接口的请求 DTO 和响应 DTO
- [ ] FLOW-02 固定工序：定义 DTO → 写 Controller 签名 → 写 Service 与数据访问 → 补测试
- [ ] FLOW-03 Controller 方法必须显式标注返回类型，且该类型是 Response DTO
- [ ] DTO-01 进入 Controller 的所有输入（body / query / param）都必须由 DTO 承接，禁止裸接对象或 `any`
- [ ] DTO-02 body、query、param 各自独立 DTO，禁止一个 DTO 兼任多种输入
- [ ] DTO-03 DTO 必须是 `class`，禁止 `interface` / `type`
- [ ] DTO-04 每个字段都要有显式校验装饰器；确实无需约束的字段也要显式声明类型装饰器
- [ ] DTO-05 全局校验管道必须开启：剥离未声明字段 + 未声明字段直接报错 + 实例化转换
- [ ] DTO-06 嵌套对象 / 数组必须显式声明嵌套校验与元素类型，否则白名单在嵌套层失效
- [ ] DTO-08 DTO 中不得出现业务方法、依赖注入、数据访问调用
- [ ] DTO-09 命名固定为 `CreateXxxDto` / `UpdateXxxDto` / `QueryXxxDto` / `XxxParamDto` / `XxxResponseDto`
- [ ] DTO-11 接口文档注解与校验装饰器写在同一个 DTO 上，禁止在 Controller 上重复描述字段
- [ ] DTO-12 禁止把请求 DTO 直接透传持久化，必须显式映射（防批量赋值越权改字段）
- [ ] DTO-14 `@IsOptional()` 必须显式决定 null 的含义：拒绝 / 视作未传 / 清空该字段，三选一并在注释里写明
- [ ] RES-01 所有接口返回统一外壳 `{ code, message, data }`，成功时 `code` 恒为 `0`
- [ ] RES-02 HTTP 状态码保留传输语义，不被外壳替代
- [ ] RES-03 每个接口必须定义 Response DTO 并作为 Controller 方法返回类型；禁止返回实体、`any`、匿名对象
- [ ] RES-04 响应字段必须显式映射到 Response DTO，禁止序列化整个实体后直接返回
- [ ] RES-05 响应中不得出现密码、盐、令牌、内部状态字段等敏感信息
- [ ] RES-06 列表接口统一分页结构 `{ list, total, page, pageSize }`
- [ ] LAYER-01 Controller 只做三件事：收已校验的 DTO、调 Service、返回 Response DTO
- [ ] LAYER-02 Controller 内不得出现业务判断、循环、数据访问、事务、外部调用
- [ ] LAYER-03 业务逻辑与 Response DTO 的组装都在 Service 完成，Controller 不做字段搬运
- [ ] LAYER-04 数据访问只经数据访问层；Service 不直接持有连接、不拼 SQL
- [ ] LAYER-05 依赖只用构造函数注入，禁止 `new` 服务、禁止服务定位器
- [ ] LAYER-06 跨模块不得直接引用对方内部实现，必须经对方模块导出的接口
- [ ] LAYER-09 裸 SQL 只许出现在数据访问层，且只许只读行锁一种；裸写在业务代码里绝对禁止
- [ ] ERR-01 业务失败必须抛出框架的 HTTP 异常家族或自定义业务异常，禁止裸 `throw new Error`
- [ ] ERR-02 错误码集中定义（枚举 / 常量），禁止业务代码中出现裸数字码或魔法字符串
- [ ] ERR-03 错误码全局唯一、按模块分段，新增需登记
- [ ] ERR-04 全局异常过滤器兜底，输出与成功响应同构的错误体
- [ ] ERR-05 未捕获异常不得向客户端泄露堆栈、SQL、内部路径、依赖版本
- [ ] ERR-06 参数校验失败的错误响应必须能定位到具体字段
- [ ] ERR-07 禁止 `catch` 后静默吞掉异常，或返回 `null` 掩盖失败
- [ ] NAME-01 文件 kebab-case 带角色后缀
- [ ] NAME-02 类 PascalCase、方法与变量 camelCase、常量 UPPER_SNAKE_CASE；私有成员不加下划线前缀
- [ ] NAME-03 路由路径小写、中划线分词、资源用复数
- [ ] NAME-05 禁止使用 `any`
- [ ] DB-01 所有业务表必须包含四个审计字段：创建时间、修改时间、创建人、最新修改人
- [ ] DB-02 数据库列名统一为 `created_at` / `updated_at` / `created_by` / `updated_by`；代码内实体属性用 camelCase 对应
- [ ] DB-03 时间字段必须无时区歧义（库内存 UTC）；创建时间写入后不可变，修改时间每次更新自动刷新
- [ ] DB-04 创建人 / 最新修改人存操作者用户标识，与鉴权主体一致；系统自动任务写约定的系统标识，不留空
- [ ] DB-05 四个字段由数据访问层统一自动填充，禁止在 Service 中手写赋值
- [ ] DB-06 业务代码不得修改创建时间与创建人
- [ ] DB-09 需要软删除的表用 `deleted_at` / `deleted_by` 标记，禁止用布尔标志位
- [ ] DB-10 连接表（两表关联）用物理删除，不用软删除
- [ ] DB-11 软删除表上的唯一约束必须排除已删除行
- [ ] DOC-01 接口文档由代码注解自动生成，禁止手工编写或手工编辑生成产物
- [ ] DOC-02 生成产物整体覆盖，不追加、不手工修补（即"覆盖式更新，非增量式更新"）
- [ ] DOC-03 文档随构建 / 发布流程重新生成，保证文档与代码同版本
- [ ] DOC-04 每个接口必须有注解声明：接口名称、功能说明、所属分组
- [ ] DOC-05 请求 DTO 每个字段必须有注解：类型、是否必填、含义、示例值；枚举字段列出全部可选值
- [ ] DOC-06 响应 DTO 每个字段必须有注解：类型、含义、是否可能为空；`X | null` 字段必须在 `@ApiProperty` 显式写 `type`（不写会退化成 `object`）
- [ ] DOC-07 每个接口至少给出一个成功响应示例与一个典型失败响应示例；失败示例必须含完整外壳（含 `data: null`）
- [ ] DOC-08 注解与代码在同一次提交内更新，禁止"先合并代码、下个迭代补注解"
- [ ] DOC-09 接口下线即删除其注解与文档，禁止注释保留"以后再删"
- [ ] DOC-13 禁止逐接口重排响应外壳样板（示例必须含完整外壳，但样板只写一次，用帮助函数）
