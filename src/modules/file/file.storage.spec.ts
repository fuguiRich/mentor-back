import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { FileStorage } from './file.storage';

describe('FileStorage', () => {
  let root: string;
  let storage: FileStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'general-back-file-'));
    storage = new FileStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('1. buildStorageName 用 uuid，带扩展名时不带点', () => {
    const name = FileStorage.buildStorageName('png');
    expect(name).toMatch(/^[0-9a-f-]{36}\.png$/);
  });

  it('2. buildStorageName 空扩展名 → 纯 uuid，不出现尾点', () => {
    expect(FileStorage.buildStorageName('')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('3. 落盘名彼此不同（同名会互相覆盖）', () => {
    const names = new Set(
      Array.from({ length: 50 }, () => FileStorage.buildStorageName('png')),
    );
    expect(names.size).toBe(50);
  });

  it('4. relativePath 是两级散列目录，落盘名在最后一级', () => {
    const name = FileStorage.buildStorageName('pdf');
    expect(storage.relativePath(name)).toBe(
      join(name.slice(0, 2), name.slice(2, 4), name),
    );
  });

  it('5. save / read 往返一致', async () => {
    const name = FileStorage.buildStorageName('png');
    const content = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await storage.save(name, content);
    expect(await storage.read(name)).toEqual(content);
  });

  it('6. absolutePath 不许跳出根目录——`..` 一律抛', () => {
    // 唯一可靠的防线是「用户字符串根本到不了拼路径那一行」（见 file.storage.ts），
    // 但兜底校验也要红得出来：将来若有人换成用原始文件名拼路径，这条会先炸。
    expect(() => storage.absolutePath('../../../etc/passwd')).toThrow(
      /非法的落盘路径/,
    );
    expect(() => storage.absolutePath('..')).toThrow(/非法的落盘路径/);
  });

  it('7. 正常的 uuid 落盘名一定落在根目录内', () => {
    const name = FileStorage.buildStorageName('png');
    const absolute = storage.absolutePath(name);
    expect(absolute.startsWith(resolve(root) + sep)).toBe(true);
  });

  it('8. remove 不存在的文件不抛（清理失败不该拖垮请求）', async () => {
    await expect(
      storage.remove(FileStorage.buildStorageName('png')),
    ).resolves.toBeUndefined();
  });

  it('9. 落盘路径不会与用户传来的原始名有关联：只按 storageName 定位', async () => {
    // 直接在根下放一个「攻击者想要」的文件，再按 uuid 读——必须读不到它。
    const decoy = join(root, 'secret.txt');
    await mkdir(root, { recursive: true });
    await writeFile(decoy, 'decoy');

    const name = FileStorage.buildStorageName('txt');
    await expect(storage.read(name)).rejects.toThrow();
    // 兜底文件仍然好好的，说明没有被覆盖 / 被删
    expect(await readFile(decoy, 'utf8')).toBe('decoy');
  });
});
