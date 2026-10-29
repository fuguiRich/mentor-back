import { withValidationErrorResponses } from './bootstrap';

type TestOp = { responses: Record<string, unknown> };

function doc(operations: Record<string, unknown>) {
  return {
    paths: { '/thing': operations },
    components: { schemas: {} },
  } as unknown as {
    paths: Record<string, Record<string, unknown>>;
    components: { schemas: Record<string, unknown> };
  };
}

function getOp(
  result: { paths: Record<string, Record<string, unknown>> },
  method: string,
): TestOp {
  return result.paths['/thing'][method] as TestOp;
}

describe('withValidationErrorResponses（R5 的 400 注入）', () => {
  it('有 requestBody 的 operation 被注入 400', () => {
    const result = withValidationErrorResponses(
      doc({
        post: {
          requestBody: { content: {} },
          responses: { '201': { description: 'created' } },
        },
      }),
    );

    const op = getOp(result, 'post');
    expect(op.responses['400']).toBeDefined();
  });

  it('有 parameters 的 operation 被注入 400', () => {
    const result = withValidationErrorResponses(
      doc({
        get: {
          parameters: [{ name: 'id', in: 'path' }],
          responses: { '200': { description: 'ok' } },
        },
      }),
    );

    const op = getOp(result, 'get');
    expect(op.responses['400']).toBeDefined();
  });

  it('既没有 parameters 也没有 requestBody 的 operation 不注入 400', () => {
    const result = withValidationErrorResponses(
      doc({ get: { responses: { '200': { description: 'ok' } } } }),
    );

    const op = getOp(result, 'get');
    expect(op.responses['400']).toBeUndefined();
  });

  it('parameters 为空数组时视为没有输入', () => {
    const result = withValidationErrorResponses(
      doc({
        get: {
          parameters: [],
          responses: { '200': { description: 'ok' } },
        },
      }),
    );

    const op = getOp(result, 'get');
    expect(op.responses['400']).toBeUndefined();
  });

  it('不覆盖已手写的 400', () => {
    const custom = { description: '手写的 400' };
    const result = withValidationErrorResponses(
      doc({
        post: {
          requestBody: { content: {} },
          responses: { '400': custom },
        },
      }),
    );

    const op = getOp(result, 'post');
    expect(op.responses['400']).toBe(custom);
  });

  it('pathItem 里的非方法键（parameters / summary）不被当成 operation', () => {
    const result = withValidationErrorResponses(
      doc({ summary: 'not a method', responses: {} }),
    );

    // 没有真实 operation ⇒ 什么都没被注入，也不抛
    expect(result.paths['/thing']).toBeDefined();
  });
});
