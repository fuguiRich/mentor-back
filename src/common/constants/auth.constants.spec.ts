import { getRounds } from 'bcryptjs';
import { BCRYPT_ROUNDS, DUMMY_PASSWORD_HASH } from './auth.constants';

describe('auth.constants', () => {
  it('DUMMY_PASSWORD_HASH 是真实 bcrypt 哈希，且 cost 与 BCRYPT_ROUNDS 一致', () => {
    // 改了 BCRYPT_ROUNDS 而忘了重生成哨兵哈希，这里会红：
    // cost 对不上时"用户不存在"与"密码错误"两条路径耗时不同。
    expect(getRounds(DUMMY_PASSWORD_HASH)).toBe(BCRYPT_ROUNDS);
  });
});
