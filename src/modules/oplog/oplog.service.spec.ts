import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../../common/constants/error-code';
import type { OpLogRepository } from './oplog.repository';
import { OpLogService, type OpLogInput } from './oplog.service';

function build(insertImpl?: (data: Record<string, unknown>) => Promise<void>): {
  service: OpLogService;
  inserted: Record<string, unknown>[];
} {
  const inserted: Record<string, unknown>[] = [];
  const repository = {
    insert: (data: Record<string, unknown>): Promise<void> => {
      inserted.push(data);
      return insertImpl ? insertImpl(data) : Promise.resolve();
    },
    findById: (): Promise<null> => Promise.resolve(null),
    findMany: (): Promise<{ rows: []; total: number }> =>
      Promise.resolve({ rows: [], total: 0 }),
  } as unknown as OpLogRepository;
  return { service: new OpLogService(repository), inserted };
}

function input(overrides: Partial<OpLogInput> = {}): OpLogInput {
  return {
    module: 'user',
    action: 'create',
    method: 'POST',
    path: '/users',
    status: 1,
    durationMs: 12,
    ...overrides,
  };
}

describe('OpLogService', () => {
  it('1. record 未登录 → operatorName 落 system（定时任务 / 系统写入）', async () => {
    const { service, inserted } = build();

    await service.record(input());

    expect(inserted[0].operatorName).toBe('system');
  });

  it('2. operatorName / ip / userAgent / errorMsg 超长会被截断到列宽', async () => {
    // 截断点是列宽：不截就 P2002 之外的另一个坑——INSERT 直接报错，
    // 而 record 是「永不抛」的，那会变成一次静默的日志丢失。
    const { service, inserted } = build();

    await service.record(
      input({
        ip: 'x'.repeat(60),
        userAgent: 'u'.repeat(300),
        errorMsg: 'e'.repeat(900),
      }),
    );

    expect(inserted[0].ip).toHaveLength(45);
    expect(inserted[0].userAgent).toHaveLength(255);
    expect(inserted[0].errorMsg).toHaveLength(500);
  });

  it('3. 快照不是对象（字符串 / 数字 / null）→ 不写 before / after', async () => {
    // Prisma 的 Json 列不收 undefined；null / 标量快照也没有记录价值。
    const { service, inserted } = build();

    await service.record(
      input({ before: 'oops', after: 42, targetId: undefined }),
    );

    expect(inserted[0]).not.toHaveProperty('before');
    expect(inserted[0]).not.toHaveProperty('after');
  });

  it('4. 快照是对象 → 原样写入', async () => {
    const { service, inserted } = build();
    const before = { status: 1 };
    const after = { status: 0 };

    await service.record(input({ before, after }));

    expect(inserted[0].before).toBe(before);
    expect(inserted[0].after).toBe(after);
  });

  it('5. 可选字段没给 → 键不出现（不写 undefined / null 占位）', async () => {
    const { service, inserted } = build();

    await service.record(input());

    expect(inserted[0]).not.toHaveProperty('targetType');
    expect(inserted[0]).not.toHaveProperty('targetId');
    expect(inserted[0]).not.toHaveProperty('ip');
    expect(inserted[0]).not.toHaveProperty('userAgent');
    expect(inserted[0]).not.toHaveProperty('errorCode');
    expect(inserted[0]).not.toHaveProperty('errorMsg');
  });

  it('6. **永不抛**：repository.insert 拒绝 → record 仍 resolve', async () => {
    // 这是本服务最重要的一条判据：日志是旁路，写失败不能把已经成功的
    // 业务请求打成 500。抛出去 = 一次磁盘抖动让全校的改密接口开始报错。
    const { service } = build(() => Promise.reject(new Error('disk full')));

    await expect(
      service.record(input({ module: 'auth', action: 'login' })),
    ).resolves.toBeUndefined();
  });

  it('7. findOne 找不到 → 27101 / 404', async () => {
    const { service } = build();

    await expect(service.findOne(1n)).rejects.toMatchObject({
      response: { code: ErrorCode.OP_LOG_NOT_FOUND },
      status: HttpStatus.NOT_FOUND,
    });
  });
});
