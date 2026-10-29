import { buildSwaggerConfig } from './bootstrap';
import { ERROR_CODE_DESCRIPTIONS } from './common/constants/error-code';

/**
 * 这组用例守的是**默认输出不变**这条红线：`docs/openapi.json` 是契约快照，
 * openapi-contract e2e 会拿它和 `buildDocument(app)` 逐字节比。定制钩子一旦
 * 在默认分支上多插一个换行，那条 e2e 就会红——而红的原因看起来像文档漂移，
 * 实际是钩子写漏了条件。在这里把边界钉死，比在 e2e 里查便宜得多。
 */
describe('buildSwaggerConfig 的定制钩子', () => {
  const descriptionOf = (
    customize?: Parameters<typeof buildSwaggerConfig>[0],
  ): string => buildSwaggerConfig(customize).info.description ?? '';

  const baseCodeLines = (): string[] =>
    Object.entries(ERROR_CODE_DESCRIPTIONS).map(
      ([code, description]) => `- ${code} ${description}`,
    );

  it('不传 customize 时标题与版本取默认值', () => {
    const config = buildSwaggerConfig();
    expect(config.info.title).toBe('通用后台管理接口');
    expect(config.info.version).toBe('1.0');
  });

  it('不传 customize 时错误码表只有 ErrorCode 枚举，不多一行也不少一行', () => {
    const description = descriptionOf();
    const expectedLines = baseCodeLines();

    for (const line of expectedLines) {
      expect(description).toContain(line);
    }
    // 末尾不应出现空行或额外条目
    expect(description.endsWith(expectedLines[expectedLines.length - 1])).toBe(
      true,
    );
  });

  it('title / version 可覆盖，不覆盖的那项仍走默认', () => {
    const config = buildSwaggerConfig({ title: '导师后台 API' });
    expect(config.info.title).toBe('导师后台 API');
    expect(config.info.version).toBe('1.0');

    const config2 = buildSwaggerConfig({ version: '2.0' });
    expect(config2.info.title).toBe('通用后台管理接口');
    expect(config2.info.version).toBe('2.0');
  });

  it('extraDescription 插在标准外壳说明之后、错误码表之前', () => {
    const description = descriptionOf({
      extraDescription: '这是导师项目的接口文档。',
    });

    const envelopeEnd = 'HTTP 状态码保留传输语义。\n\n';
    const tableStart = '错误码一览（由 `ErrorCode` 枚举生成）：\n';

    expect(description.indexOf(envelopeEnd)).toBeGreaterThan(-1);
    expect(description.indexOf('这是导师项目的接口文档。')).toBeGreaterThan(
      description.indexOf(envelopeEnd),
    );
    expect(description.indexOf('这是导师项目的接口文档。')).toBeLessThan(
      description.indexOf(tableStart),
    );
  });

  it('不传 extraDescription 时不插那对换行', () => {
    expect(descriptionOf({ extraDescription: '' })).toBe(descriptionOf());
  });

  it('extraErrorCodes 追加在枚举之后，且不动枚举自身的行', () => {
    const description = descriptionOf({
      extraErrorCodes: {
        30101: '笔记不存在',
        30102: '标题重复',
      },
    });

    const lines = baseCodeLines();
    const lastBaseIndex = description.indexOf(lines[lines.length - 1]);
    const firstExtraIndex = description.indexOf('- 30101 笔记不存在');

    expect(firstExtraIndex).toBeGreaterThan(-1);
    expect(description).toContain('- 30102 标题重复');
    // 追加的排在全部枚举之后，不插队
    expect(firstExtraIndex).toBeGreaterThan(lastBaseIndex);
  });

  it('不传 extraErrorCodes 时表内容与传空对象完全一致', () => {
    expect(descriptionOf({ extraErrorCodes: {} })).toBe(descriptionOf());
  });
});
