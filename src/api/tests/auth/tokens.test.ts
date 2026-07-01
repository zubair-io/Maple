import { describe, it, expect } from 'bun:test';
import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
} from '../../src/auth/tokens.ts';

const SECRET = 'test-secret-32-bytes-long-xxxxxx';

describe('tokens', () => {
  it('signs and verifies an access token', async () => {
    const jwt = await signAccessToken({ sub: 'u1', email: 'a@b.c', role: 'owner' }, SECRET);
    const claims = await verifyAccessToken(jwt, SECRET);
    expect(claims.sub).toBe('u1');
    expect(claims.role).toBe('owner');
  });

  it('issues short-lived access tokens (≤15 min) by default (#860)', async () => {
    const jwt = await signAccessToken({ sub: 'u1', email: 'a@b.c', role: 'owner' }, SECRET);
    const { iat, exp } = await verifyAccessToken(jwt, SECRET);
    expect(exp - iat).toBeLessThanOrEqual(15 * 60);
    expect(exp - iat).toBeGreaterThan(0);
  });

  it('rejects a tampered access token', async () => {
    const jwt = await signAccessToken({ sub: 'u1', email: 'a@b.c', role: 'owner' }, SECRET);
    const [h, p, s] = jwt.split('.');
    // Flip the first signature char (a full 6-bit base64url position) to a
    // guaranteed-different one so the decoded bytes always change. The previous
    // `${s.slice(0, -2)}xx` tamper hit the final char, which carries only 4
    // significant bits, so ~1/512 signings it decoded unchanged and the
    // "tamper" was a no-op (flaky). See #1674.
    const flipped = s[0] === 'A' ? 'B' : 'A';
    const bad = `${h}.${p}.${flipped}${s.slice(1)}`;
    // Assert the SIGNATURE failure specifically (matching the sibling
    // wrong-secret test) so a future regression can't make this pass for an
    // unrelated reason — e.g. a malformed token/claims error.
    await expect(verifyAccessToken(bad, SECRET)).rejects.toThrow(/signature/i);
  });

  it('rejects a token signed with a different secret', async () => {
    const jwt = await signAccessToken({ sub: 'u1', email: 'a@b.c', role: 'owner' }, SECRET);
    await expect(verifyAccessToken(jwt, 'y'.repeat(32))).rejects.toThrow(/signature/i);
  });

  it('rejects an expired access token', async () => {
    const jwt = await signAccessToken({ sub: 'u1', email: 'a@b.c', role: 'owner' }, SECRET, {
      expiresInSeconds: -1,
    });
    await expect(verifyAccessToken(jwt, SECRET)).rejects.toThrow(/expired/i);
  });

  it('rejects an alg-confusion token (forged alg: none)', async () => {
    // A token whose header claims `alg: none` with an empty signature must be
    // rejected — verification is pinned to HS256, so jose never accepts it.
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'u1', email: 'a@b.c', role: 'owner', exp: 9999999999 })}.`;
    await expect(verifyAccessToken(forged, SECRET)).rejects.toThrow();
  });

  it('generates 32-byte base64url refresh tokens', () => {
    const t = generateRefreshToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes refresh tokens deterministically', () => {
    expect(hashRefreshToken('abc')).toBe(hashRefreshToken('abc'));
    expect(hashRefreshToken('abc')).not.toBe(hashRefreshToken('abd'));
  });
});
