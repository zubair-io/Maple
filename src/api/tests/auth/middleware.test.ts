// src/api/tests/auth/middleware.test.ts
import { describe, it, expect } from 'bun:test';
import { Elysia } from 'elysia';
import { requireAuth, requireOwner } from '../../src/auth/middleware.ts';
import { signAccessToken } from '../../src/auth/tokens.ts';

const SECRET = 'test-secret-32-bytes-xxxxxxxxxxxx';
process.env.MAPLE_JWT_SECRET = SECRET;

const app = new Elysia()
  .use(requireAuth)
  .get('/me', ({ auth }) => ({ sub: auth.user.sub }))
  .use(requireOwner)
  .post('/owner-only', () => ({ ok: true }));

const imageApp = new Elysia()
  .use(requireAuth)
  .get('/api/thumb/demo/photo.jpg', ({ auth }) => ({ sub: auth.user.sub }))
  .get('/api/preview/demo/photo.jpg', ({ auth }) => ({ sub: auth.user.sub }));

describe('image routes require bearer authentication (#3764)', () => {
  it.each(['thumb', 'preview'])(
    'rejects URL tokens on %s without querying storage',
    async (route) => {
      const response = await imageApp.handle(
        new Request(`http://localhost/api/${route}/demo/photo.jpg?token=${'T'.repeat(43)}`),
      );
      expect(response.status).toBe(401);
    },
  );

  it.each(['thumb', 'preview'])(
    'keeps a valid bearer identity on %s with a URL token',
    async (route) => {
      const token = await signAccessToken(
        { sub: 'u1', email: 'a@b.c', role: 'member', file_access: true },
        SECRET,
      );
      const response = await imageApp.handle(
        new Request(`http://localhost/api/${route}/demo/photo.jpg?token=${'T'.repeat(43)}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ sub: 'u1' });
    },
  );
});

describe('middleware', () => {
  it('rejects /me without bearer', async () => {
    const r = await app.handle(new Request('http://localhost/me'));
    expect(r.status).toBe(401);
  });
  it('accepts /me with valid bearer', async () => {
    const t = await signAccessToken(
      { sub: 'u1', email: 'a@b.c', role: 'member', file_access: true },
      SECRET,
    );
    const r = await app.handle(
      new Request('http://localhost/me', { headers: { authorization: `Bearer ${t}` } }),
    );
    expect(r.status).toBe(200);
  });
  it('rejects member from owner route', async () => {
    const t = await signAccessToken(
      { sub: 'u1', email: 'a@b.c', role: 'member', file_access: true },
      SECRET,
    );
    const r = await app.handle(
      new Request('http://localhost/owner-only', {
        method: 'POST',
        headers: { authorization: `Bearer ${t}` },
      }),
    );
    expect(r.status).toBe(403);
  });
  it('allows owner on owner route', async () => {
    const t = await signAccessToken(
      { sub: 'u1', email: 'a@b.c', role: 'owner', file_access: true },
      SECRET,
    );
    const r = await app.handle(
      new Request('http://localhost/owner-only', {
        method: 'POST',
        headers: { authorization: `Bearer ${t}` },
      }),
    );
    expect(r.status).toBe(200);
  });
});
