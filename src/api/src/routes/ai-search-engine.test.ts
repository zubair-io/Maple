import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { aiRoutes } from './ai.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { withTestEnv } from '../test-support/env.test-helpers.ts';
import { signAccessToken } from '../auth/tokens.ts';
import { loadEnrichmentConfig } from '../enrichment/enrichment-config.repo.ts';
import {
  resetSearchEngineSelectionForTests,
  selectedSearchEngine,
} from '../search/search-engine-selection.ts';
import { setSearchChildPoolForTests } from '../search/search-pool.ts';
import { fakeChildPool, type FakeChild } from '../search/search.test-helpers.ts';
import { searchChildConfig } from '../search/search-child-config.ts';

withTestEnv('MAPLE_JWT_SECRET', 'x'.repeat(32));

let live: LiveTestDatabase;
let owner: string;
let member: string;
let children: FakeChild[];

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
  resetSearchEngineSelectionForTests();
  const fake = fakeChildPool(searchChildConfig);
  children = fake.children;
  setSearchChildPoolForTests(fake.pool);
});

afterEach(() => {
  setSearchChildPoolForTests(null);
  resetSearchEngineSelectionForTests();
  live.close();
});

const app = new Elysia().use(aiRoutes);

function request(method: 'GET' | 'PUT', body?: unknown, token = owner) {
  return app.handle(
    new Request('http://localhost/api/ai/search-engine/', {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

describe('/api/ai/search-engine', () => {
  it('defaults to Meilisearch with the child stopped', async () => {
    const response = await request('GET');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      engine: 'meilisearch',
      status: { phase: 'stopped', vectors: 0 },
    });
    expect(children).toEqual([]);
  });

  it('saves the choice in the enrichment settings, starts the child and stops it again', async () => {
    const selected = await (await request('PUT', { engine: 'in-process' })).json();

    expect(selected).toMatchObject({ engine: 'in-process', status: { phase: 'starting' } });
    expect((await loadEnrichmentConfig())?.search_engine).toBe('in-process');
    expect(children[0]!.sent[0]?.type).toBe('start');
    resetSearchEngineSelectionForTests();
    expect(await selectedSearchEngine()).toBe('in-process');

    const back = await (await request('PUT', { engine: 'meilisearch' })).json();

    expect(back).toMatchObject({ engine: 'meilisearch', status: { phase: 'stopped' } });
    expect(children[0]!.terminated).toBe(true);
  });

  it('rejects an unknown engine and a non-owner', async () => {
    expect((await request('PUT', { engine: 'elasticsearch' })).status).toBe(422);
    expect((await request('PUT', { engine: 'in-process' }, member)).status).toBe(403);
    expect((await request('GET', undefined, member)).status).toBe(403);
    expect(children).toEqual([]);
  });
});
