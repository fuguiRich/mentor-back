import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * 落盘路径的**唯一**定义处。全项目不许再有一处 `join(FILE_ROOT, …)`——
 * 路径拼接的规则散在几个地方时，总有一天会有一处忘了校验。
 *
 * 磁盘名（storageName）由 uuid 生成，**永不使用用户传来的原始文件名**：
 * 路径穿越的唯一可靠防线，是让攻击者控制的字符串根本到不了拼路径那一行，
 * 而不是在那一行上做一堆 replace。
 */
export class FileStorage {
  constructor(private readonly root: string) {}

  /** 生成落盘名：uuid + 扩展名。ext 不含点；允许 ext 为空 */
  static buildStorageName(ext: string): string {
    return ext === '' ? randomUUID() : `${randomUUID()}.${ext}`;
  }

  /**
   * 两级散列目录：<root>/<aa>/<bb>/<storageName>。
   * uuid 的前 4 个 hex 位天然均匀，16^4 = 65536 个叶子目录，
   * 几万文件也不会让单个目录胖到让 readdir / 某些文件系统变慢。
   */
  relativePath(storageName: string): string {
    return join(storageName.slice(0, 2), storageName.slice(2, 4), storageName);
  }

  absolutePath(storageName: string): string {
    const absolute = resolve(this.root, this.relativePath(storageName));
    // 兜底：即使 storageName 将来由别人生成且带了 `..`，也不许跳出根目录
    if (!absolute.startsWith(resolve(this.root) + sep)) {
      throw new Error(`非法的落盘路径：${storageName}`);
    }
    return absolute;
  }

  async save(storageName: string, content: Buffer): Promise<void> {
    const target = this.absolutePath(storageName);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  async read(storageName: string): Promise<Buffer> {
    return readFile(this.absolutePath(storageName));
  }

  /** 硬删除磁盘文件。软删除只改数据库；磁盘清理走归档策略，不在请求路径上做 */
  async remove(storageName: string): Promise<void> {
    await rm(this.absolutePath(storageName), { force: true });
  }
}
