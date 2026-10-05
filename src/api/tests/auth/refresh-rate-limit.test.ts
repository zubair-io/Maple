import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { authRoutes } from '../../src/routes/auth.ts';
import { __resetRateLimitForTests } from '../../src/auth/rate_limit.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';

const app = new Elysia().use(authRoutes);
let live: LiveTestDatabase;

beforeEach(async () => {
  __resetRateLimitForTests();
  live = await createLiveTestDatabase();
});

afterEach(() => {
  live.close();
  __resetRateLimitForTests();
});

function post(path: string, body: object = {}, cookie?: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/api/auth/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.191',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

describe('refresh rate limiting on the sign-in page', () => {
  it('does not spend passkey registration attempts on credential-free hydration', async () => {
    for (let i = 0; i < 12; i++) {
      const response = await post('refresh', i % 2 ? { refresh_token: '   ' } : {});
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'no refresh token' });
    }
    expect((await post('register/options')).status).toBe(200);
  });

  it.each(['body', 'cookie'])('still limits invalid %s credential attempts', async (source) => {
    const attempt = () =>
      source === 'body'
        ? post('refresh', { refresh_token: 'invalid-token' })
        : post('refresh', {}, 'maple_refresh=invalid-token');
    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(401);
    const response = await attempt();
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'rate limited' });
    expect((await post('register/options')).status).toBe(429);
  });
});
