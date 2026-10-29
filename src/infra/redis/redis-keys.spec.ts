import { redisKeys } from './redis-keys';

describe('redisKeys', () => {
  it('authPrefix 是所有 auth 键的前缀——新增键必须落进这棵子树', () => {
    const makers = Object.values(redisKeys.auth);
    expect(makers.length).toBeGreaterThan(0);

    // 将来有人新增一个不在这棵子树里的键，这里会红，
    // 而不是让 e2e 的按键前缀清库把它漏掉。
    for (const makeKey of makers) {
      expect(makeKey('sample').startsWith(redisKeys.authPrefix)).toBe(true);
    }
  });
});
