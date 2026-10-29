import { contentDisposition } from './content-disposition';

describe('contentDisposition', () => {
  it('1. 普通 ASCII 文件名：两个字段都给，ascii 原样', () => {
    expect(contentDisposition('attachment', 'report.pdf')).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it('2. 引号与反斜杠在 filename= 里换成 _——否则一个文件名就能把响应头断开', () => {
    const value = contentDisposition('inline', `a"b\\c.pdf`);
    // 头注入的反例：若原样保留引号，攻击者能在这里收掉引号并续上任意头
    expect(value).toContain('filename="a_b_c.pdf"');
    expect(value).not.toContain('a"b');
  });

  it('3. CR / LF / 控制字符一律换成 _（响应头拆分的反例）', () => {
    const value = contentDisposition(
      'attachment',
      'evil\r\nX-Injected: 1\r\n\r\n.pdf',
    );
    expect(value).not.toMatch(/[\r\n]/);
    // 逐字符翻译：CR/LF → `_`，可打印 ASCII（冒号、空格）原样留着。
    // `evil` + 2 个 → `__`，`1` 之后 4 个 → `____`，然后是 `.pdf`
    expect(value).toContain('filename="evil__X-Injected: 1____.pdf"');
    // 真名走 filename*，那里也不会出现裸的 CR/LF
    expect(value).not.toMatch(/filename\*=[^\n]*[\r\n]/);
  });

  it('4. 中文 / emoji 在 filename= 里换成 _，在 filename* 里走 RFC 5987', () => {
    const value = contentDisposition('attachment', '中文.png');
    expect(value).toContain('filename="__.png"');
    expect(value).toContain(`filename*=UTF-8''%E4%B8%AD%E6%96%87.png`);
  });

  it("5. encodeURIComponent 放行的 ' ( ) * 在 attr-char 之外，要补转", () => {
    // 这四个在 RFC 5987 的 attr-char 之外，但 encodeURIComponent 当成未保留字符放行。
    // 不补转，某些客户端会把 filename* 整段解析失败，退回 filename= 那个兜底名。
    // （`!` 不在其列——它在 attr-char 里是合法的，不该被转。）
    const value = contentDisposition('attachment', "a!b'c(d)e*f.png");
    expect(value).toContain(`filename*=UTF-8''a!b%27c%28d%29e%2Af.png`);
  });

  it('6. 文件名全是不可打印字符 → 兜底名 file，不留空引号', () => {
    const value = contentDisposition('attachment', '   ');
    expect(value).toContain('filename="file"');
  });

  it('7. type 只可能是 inline / attachment，且原样出现在头首', () => {
    expect(contentDisposition('inline', 'a.png').startsWith('inline; ')).toBe(
      true,
    );
    expect(
      contentDisposition('attachment', 'a.png').startsWith('attachment; '),
    ).toBe(true);
  });
});
