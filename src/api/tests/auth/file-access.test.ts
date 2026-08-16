// File-access permission (#2893) — token claim round-trip, guard behavior,
// and the pre-upgrade-token fallback.

import { describe, it, expect } from 'bun:test';
import { Elysia } from 'elysia';
import { SignJWT } from 'jose';
import { signAccessToken, verifyAccessToken } from '../../src/auth/tokens.ts';
import { requireAuth, requireFileAccess } from '../../src/auth/middleware.ts';
import { userFileAccess } from '../../src/auth/permissions.ts';

const SECRET = 'test-secret-32-bytes-long-xxxxxx';
process.env.MAPLE_JWT_SECRET = SECRET;

describe('file_access claim', () => {
  it('round-trips through sign/verify', async () => {
    const jwt = await signAccessToken(
      { sub: 'u1', email: 'a@b.c', role: 'member', file_access: false },
      SECRET,
    );
    const claims = await verifyAccessToken(jwt, SECRET);
    expect(claims.file_access).toBe(false);
  });

  it('treats a pre-#2893 token (no claim) as having file access', async () => {
    // Hand-roll a token without the file_access claim — the shape every
    // in-flight token has during a rolling upgrade.
    const now = Math.floor(Date.now() / 1000);
    const legacy = await new SignJWT({ email: 'a@b.c', role: 'member' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('u1')
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(new TextEncoder().encode(SECRET));
    const claims = await verifyAccessToken(legacy, SECRET);
    expect(claims.file_access).toBe(true);
  });

  it('an owner token always verifies with file access, even if minted false', async () => {
    const jwt = await signAccessToken(
      { sub: 'u1', email: 'a@b.c', role: 'owner', file_access: false },
      SECRET,
    );
    const claims = await verifyAccessToken(jwt, SECRET);
    expect(claims.file_access).toBe(true);
  });
});

describe('userFileAccess', () => {
  it('grants owners unconditionally', () => {
    expect(userFileAccess({ role: 'owner', file_access: false })).toBe(true);
  });
  it('grants members by default (absent field)', () => {
    expect(userFileAccess({ role: 'member' })).toBe(true);
  });
  it('denies members with an explicit revoke', () => {
    expect(userFileAccess({ role: 'member', file_access: false })).toBe(false);
  });
});

describe('requireFileAccess guard', () => {
  const app = new Elysia()
    .use(requireAuth)
    .get('/open', () => ({ ok: true }))
    .use(new Elysia().use(requireFileAccess).get('/gated', () => ({ ok: true })));

  async function call(path: string, fileAccess: boolean) {
    const jwt = await signAccessToken(
      { sub: 'u1', email: 'a@b.c', role: 'member', file_access: fileAccess },
      SECRET,
    );
    return app.handle(
      new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${jwt}` } }),
    );
  }

  it('403s a member without file access on a gated route', async () => {
    const r = await call('/gated', false);
    expect(r.status).toBe(403);
    expect((await r.json()).error).toContain('file access');
  });

  it('passes a member with file access on a gated route', async () => {
    const r = await call('/gated', true);
    expect(r.status).toBe(200);
  });

  it('leaves sibling open routes reachable for a member without file access', async () => {
    const r = await call('/open', false);
    expect(r.status).toBe(200);
  });

  it('still 401s without any bearer', async () => {
    const r = await app.handle(new Request('http://localhost/gated'));
    expect(r.status).toBe(401);
  });
});
