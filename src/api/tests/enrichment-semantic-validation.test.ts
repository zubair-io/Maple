/**
 * Semantic-search settings validation and the connection test's readiness
 * report: what PUT /api/enrichment/config refuses to save, and what
 * POST /api/enrichment/test-meili reports back beyond a bare health check.
 *
 * Storage is SQLite (#3787): the saved config is one row of `app_settings`,
 * and each test gets a private database installed as the process-wide handle.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { signAccessToken } from '../src/auth/tokens.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { newObjectIdHex } from '../src/db/sqlite/object-id.ts';
import { withTestEnv } from '../src/test-support/env.test-helpers.ts';
import { seedEnrichmentConfig } from './helpers/enrichment-route-fixtures.ts';

// Never restored, these left both workers disabled for every later suite.
withTestEnv('MAPLE_GEOCODE_WORKER_ENABLED', 'false');
withTestEnv('MAPLE_DESCRIBE_WORKER_ENABLED', 'false');
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

const realFetch = globalThis.fetch;
let live: LiveTestDatabase;
let app: Pick<Elysia, 'handle'> | null = null;

// PUT /config is owner-gated (#2353); the other routes exercised here
// (POST /test-meili) only need a valid bearer, so an owner token covers both.
const ownerJwt = await signAccessToken(
  { file_access: true, sub: newObjectIdHex(), email: 'o@m.c', role: 'owner' },
  'x'.repeat(32),
);

beforeAll(async () => {
  const { enrichmentRoutes } = await import('../src/routes/enrichment.ts');
  app = new Elysia().use(enrichmentRoutes);
});

beforeEach(async () => {
  live = await createLiveTestDatabase();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  live.close();
});

async function request(method: 'POST' | 'PUT', path: string, body: object) {
  const response = await app!.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerJwt}` },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('semantic settings validation and connection readiness', () => {
  it('rejects a malformed shared Ollama URL and semantic mode without Meilisearch', async () => {
    const malformed = await request('PUT', '/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      describe_provider_url: 'not-a-url',
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toContain('Invalid describe_provider_url');

    const missingMeili = await request('PUT', '/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      meilisearch_semantic_enabled: true,
    });
    expect(missingMeili.status).toBe(400);
    expect(missingMeili.body.error).toContain('requires a Meilisearch URL');
  });

  it('uses the saved write-only key when the test field is blank', async () => {
    seedEnrichmentConfig(live.db, { meilisearch_api_key: 'saved-secret' });
    let authorization: string | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('authorization');
      return new Response(JSON.stringify({ status: 'available' }), { status: 200 });
    }) as typeof fetch;

    const result = await request('POST', '/api/enrichment/test-meili', {
      meilisearch_url: 'http://meili.test:7700',
    });
    expect(result.body).toMatchObject({ ok: true });
    expect(authorization === 'Bearer saved-secret').toBe(true);
  });

  it('returns semantic readiness details instead of health-only success', async () => {
    seedEnrichmentConfig(live.db, {
      meilisearch_semantic_enabled: true,
      meilisearch_embedder_model: 'bge-m3',
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(input.toString()).pathname;
      const body = path.endsWith('/health')
        ? { status: 'available' }
        : path.endsWith('/stats')
          ? { numberOfDocuments: 10, isIndexing: false }
          : {};
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    const result = await request('POST', '/api/enrichment/test-meili', {
      meilisearch_url: 'http://meili.test:7700',
    });
    expect(result.body).toMatchObject({
      ok: false,
      semanticReady: false,
      semantic: {
        embedderName: 'caption',
        model: 'bge-m3',
        meilisearchReachable: true,
        embedderConfigured: false,
      },
    });
  });
});
