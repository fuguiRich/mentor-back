import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createAuditedExtension } from './prisma.extension';

/**
 * 交互式事务的句柄类型（`$transaction(async (tx) => …)` 的 `tx`）。
 *
 * `client` 是 `$extends` 后的实例，它 `$transaction` 回调里的句柄与裸的
 * `Prisma.TransactionClient` 在深层泛型上**不相容**（扩展改写了模型方法的
 * 签名，`Exact<>` 约束对不上）。所以从 `$transaction` 自己的回调签名里取真型，
 * 事务内复用的持久层方法（如 `MentorRepository.updateDraft`）与调用方共用
 * 这一个别名，谁都不做强转。
 */
export type PrismaTx = Parameters<
  Parameters<PrismaService['client']['$transaction']>[0]
>[0];

/**
 * 数据访问的唯一入口。
 *
 * `client` 是业务代码默认使用的实例：自动填审计字段、自动过滤已删除数据。
 * `includingDeleted` 保留给「确需查询已删除数据」的场景（规范 DB-09 要求
 * 这种情况必须显式声明，不能靠碰巧没写过滤条件）。
 *
 * 两者由同一个 base 派生，`$extends` 不新建连接池，因此仍然只有一个池。
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  /**
   * `new PrismaClient()` 写成**实例字段**而不是模块级常量：`src/index.ts` 把本类
   * 导出了去，而「只 import 一下就建一个连接池」是不该有的副作用——使用方可能
   * 只是想拿 `BusinessException`，却被迫先连上数据库，没配 `DATABASE_URL` 时甚至
   * 在加载阶段就抛。字段初始化器在 provider 构造时才跑，与它作为单例 provider 的
   * 生命周期一致，行为上与原来的模块级常量等价（app 只建一次 PrismaService）。
   */
  private readonly base = new PrismaClient();

  readonly client = this.base.$extends(
    createAuditedExtension({ softDelete: true }),
  );
  readonly includingDeleted = this.base.$extends(
    createAuditedExtension({ softDelete: false }),
  );

  async onModuleInit(): Promise<void> {
    await this.base.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.base.$disconnect();
  }
}
