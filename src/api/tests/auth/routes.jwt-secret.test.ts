// src/api/tests/auth/routes.jwt-secret.test.ts
import { describe, it, expect } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId } from 'mongodb';
import { authRoutes } from '../../src/routes/auth.ts';
import { signAccessToken } from '../../src/auth/tokens.ts';

process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);
const app = new Elysia().use(authRoutes);

const ownerJwt = await signAccessToken(
  { sub: new ObjectId().toHexString(), email: 'o@m.c', role: 'owner' },
  'x'.repeat(32),
);
const memberJwt = await signAccessToken(
  { sub: new ObjectId().toHexString(), email: 'm@m.c', role: 'member' },
  'x'.repeat(32),
);

describe('GET /api/auth/jwt-secret', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const r = await app.handle(new Request('http://localhost/api/auth/jwt-secret'));
    expect(r.status).toBe(401);
  });

  it('rejects a member-role token with 403', async () => {
    const r = await app.handle(
      new Request('http://localhost/api/auth/jwt-secret', {
        headers: { authorization: `Bearer ${memberJwt}` },
      }),
    );
    expect(r.status).toBe(403);
  });

  it('returns the raw secret to an owner, with Cache-Control: no-store', async () => {
    const r = await app.handle(
      new Request('http://localhost/api/auth/jwt-secret', {
        headers: { authorization: `Bearer ${ownerJwt}` },
      }),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = await r.json();
    expect(body.secret).toBe(process.env.MAPLE_JWT_SECRET);
  });
});
