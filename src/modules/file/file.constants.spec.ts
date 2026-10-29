import {
  ALLOWED_FILE_TYPES,
  FILE_MAX_COUNT,
  MAGIC_HEAD_BYTES,
  detectTypeByMagic,
  findTypeByExt,
} from './file.constants';

function head(bytes: readonly number[]): Buffer {
  return Buffer.concat([
    Buffer.from(bytes),
    Buffer.alloc(MAGIC_HEAD_BYTES, 0x20),
  ]);
}

describe('file.constants', () => {
  it('1. 白名单里只有带可靠魔数的类型——svg 与 txt 不在其中', () => {
    const exts: string[] = [];
    for (const type of ALLOWED_FILE_TYPES) {
      for (const ext of type.exts) {
        exts.push(ext);
      }
    }
    expect(exts).toEqual(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'pdf']);
    // 这两条是**判据**不是备注：svg 能内嵌 <script>，txt 没有魔数，
    // 任何一个被加进来都意味着「验过了」这句话开始说假话。
    expect(exts).not.toContain('svg');
    expect(exts).not.toContain('txt');
  });

  it('2. findTypeByExt 大小写不敏感，且扩展名不带点', () => {
    expect(findTypeByExt('PNG')?.mime).toBe('image/png');
    expect(findTypeByExt('Jpeg')?.mime).toBe('image/jpeg');
    expect(findTypeByExt('.png')).toBeUndefined();
    expect(findTypeByExt('exe')).toBeUndefined();
  });

  it('3. detectTypeByMagic 按字节认，与扩展名无关（伪装 mimetype 的反例）', () => {
    expect(
      detectTypeByMagic(head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        ?.exts[0],
    ).toBe('png');
    expect(detectTypeByMagic(head([0x25, 0x50, 0x44, 0x46]))?.exts[0]).toBe(
      'pdf',
    );
  });

  it('4. webp 要同时满足 RIFF 与 WEBP 两段——只有 RIFF 不算', () => {
    const riffOnly = head([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41]);
    const webp = head([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(detectTypeByMagic(riffOnly)).toBeUndefined();
    expect(detectTypeByMagic(webp)?.exts[0]).toBe('webp');
  });

  it('5. 不认识的字节 / 空 buffer → undefined（宁可拒收）', () => {
    expect(detectTypeByMagic(head([0x00, 0x01, 0x02]))).toBeUndefined();
    expect(detectTypeByMagic(Buffer.alloc(0))).toBeUndefined();
  });

  it('6. 文件头比签名还短时不误判：PNG 只给前 4 字节 → 不算', () => {
    // startsWith 要求 head 长度 ≥ 签名长度。这里短 4 字节，
    // 若实现改成「比较有的那些」就会把截断的伪文件放进来。
    expect(
      detectTypeByMagic(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    ).toBeUndefined();
  });

  it('7. FILE_MAX_COUNT 是 10 且不可配——它是「一次提交」的语义边界', () => {
    expect(FILE_MAX_COUNT).toBe(10);
  });
});
