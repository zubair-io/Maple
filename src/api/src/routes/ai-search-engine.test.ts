import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { aiRoutes } from './ai.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { withTestEnv } from '../test-support/env.test-helpers.ts';
import { signAccessToken } from '../auth/tokens.ts';
import { setSearchChildPoolForTests } from '../search/search-pool.ts';
import { fakeChildPool } from '../search/search.test-helpers.ts';
import { searchChildConfig } from '../search/search-child-config.ts';

withTestEnv('MAPLE_JWT_SECRET', 'x'.repeat(32));

let live: LiveTestDatabase;
let owner: string;
let member: string;

beforeAll(async () => {
  owner = await signAccessToken(
    { sub: 'search-owner', email: 'owner@example.com', role: 'owner', file_access: true },
    'x'.repeat(32),
  );
  member = await signAccessToken(
    { sub: 'search-member', email: 'member@example.com', role: 'member', file_access: true },
    'x'.repeat(32),
  );
});

beforeEach(async () => {
  live = await createLiveTestDatabase();
  setSearchChildPoolForTests(fakeChildPool(searchChildConfig).pool);
});

afterEach(() => {
  setSearchChildPoolForTests(null);
  live.close();
});

const app = new Elysia().use(aiRoutes);

function request(token = owner) {
  return app.handle(
    new Request('http://localhost/api/ai/search-engine/', {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

describe('/api/ai/search-engine', () => {
  it('reports the search child status to the owner', async () => {
    const response = await request();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: { phase: 'stopped', vectors: 0 } });
  });

  it('refuses a non-owner', async () => {
    expect((await request(member)).status).toBe(403);
  });
});
