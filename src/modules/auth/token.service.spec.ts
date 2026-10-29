import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { TokenService } from './token.service';

// 真 JwtService + 假 ConfigService，不连任何外部服务
const config = {
  getOrThrow: (key: string) => (key === 'jwt.accessTtlSeconds' ? 7200 : 604800),
} as unknown as ConfigService;

function makeService(secret = 'x'.repeat(32)): TokenService {
  return new TokenService(
    new JwtService({ secret, signOptions: { algorithm: 'HS256' } }),
    config,
  );
}

const accessInput = {
  userId: 42n,
  username: 'alice',
  sv: 3,
  isSuperAdmin: false,
};

describe('TokenService', () => {
  it('① signAccess → verifyAccess 往返：sub 是字符串形式的用户 ID，其余字段原样', async () => {
    const service = makeService();
    const issued = await service.signAccess(accessInput);

    expect(issued.expiresIn).toBe(7200);

    const result = service.verifyAccess(issued.token);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`期望校验成功，实际 ${result.reason}`);
    }

    expect(result.payload.sub).toBe('42');
    expect(result.payload.username).toBe('alice');
    expect(result.payload.sv).toBe(3);
    expect(result.payload.isSuperAdmin).toBe(false);
    expect(result.payload.jti).toBe(issued.jti);
  });

  it('② 篡改：签名部分最后一个字符改掉 → invalid', async () => {
    const service = makeService();
    const issued = await service.signAccess(accessInput);

    const parts = issued.token.split('.');
    const signature = parts[2];
    const flipped =
      signature.slice(0, -1) + (signature.endsWith('A') ? 'B' : 'A');
    const tampered = `${parts[0]}.${parts[1]}.${flipped}`;

    expect(service.verifyAccess(tampered)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('③ 换密钥签发的令牌 → invalid', async () => {
    const issued = await makeService('y'.repeat(32)).signAccess(accessInput);

    expect(makeService().verifyAccess(issued.token)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('④ 过期：expiresIn: -1 签一枚 → reason 是 expired 而不是 invalid', async () => {
    const expiredService = new TokenService(
      new JwtService({
        secret: 'x'.repeat(32),
        signOptions: { algorithm: 'HS256' },
      }),
      { getOrThrow: () => -1 } as unknown as ConfigService,
    );
    const issued = await expiredService.signAccess(accessInput);

    expect(makeService().verifyAccess(issued.token)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('⑤ 类型串用：refresh 接不进 verifyAccess，access 也进不了 verifyRefresh', async () => {
    const service = makeService();
    const access = await service.signAccess(accessInput);
    const refresh = await service.signRefresh({ userId: 42n, sv: 3 });

    expect(service.verifyRefresh(access.token)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(service.verifyAccess(refresh.token)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('⑥ verifyAccess("not-a-jwt") → invalid，不抛异常', () => {
    const service = makeService();

    expect(service.verifyAccess('not-a-jwt')).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('⑦ 算法钉死 HS256：用 HS512 签的令牌 → invalid', async () => {
    const hs512 = new JwtService({
      secret: 'x'.repeat(32),
      signOptions: { algorithm: 'HS512' },
    });
    const token = await hs512.signAsync(
      { sub: '42', username: 'alice', sv: 3, isSuperAdmin: false },
      { jwtid: 'j', expiresIn: 7200 },
    );

    expect(makeService().verifyAccess(token)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('⑧ 载荷缺 exp（没设过期时刻的自签令牌）→ invalid', async () => {
    const service = makeService();
    const jwt = new JwtService({
      secret: 'x'.repeat(32),
      signOptions: { algorithm: 'HS256' },
    });
    const token = await jwt.signAsync(
      { sub: '42', username: 'alice', sv: 3, isSuperAdmin: false },
      { jwtid: 'j' },
    );

    expect(service.verifyAccess(token)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});
