/**
 * POST /api/admin/enrichment/backfill-meilisearch — owner gate (#2353).
 * Split out of `admin-backfill-meilisearch.test.ts` to stay under the
 * repo's 600-line file budget (see CONTRIBUTING.md § "File-size budget").
 *
 * The route is owner-gated: a `?reset=true` call discards backfill progress
 * and re-scans the whole library, so it must not be reachable by any member.
 *
 * The gate itself never reads the database, but the handler behind it does —
 * the 200 case falls through to `runMeilisearchBackfill`, which resolves
 * `sqliteDb()` with no override. So each test installs a private database for
 * the duration of its block (#3787).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import {
  setMeilisearchClientForTests,
  type MeilisearchClient,
} from '../src/enrichment/meilisearch-client.ts';
import { signAccessToken } from '../src/auth/tokens.ts';
import { createLiveTestDatabase } from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { newObjectIdHex } from '../src/db/object-id.ts';
import { meilisearchBackfillRoutes } from '../src/routes/admin-backfill-meilisearch.ts';

process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

const ownerJwt = await signAccessToken(
  { file_access: true, sub: newObjectIdHex(), email: 'o@m.c', role: 'owner' },
  'x'.repeat(32),
);
const memberJwt = await signAccessToken(
  { file_access: true, sub: newObjectIdHex(), email: 'm@m.c', role: 'member' },
  'x'.repeat(32),
);

afterEach(() => {
  setMeilisearchClientForTests(null);
});

function makeUnconfiguredMeili(): MeilisearchClient {
  return {
    isConfigured: () => false,
    semanticConfigured: () => false,
    health: async () => false,
    ensureIndex: async () => {},
    upsert: async () => {},
    upsertOrThrow: async () => {},
    upsertBatchOrThrow: async () => {},
    tombstoneBatchOrThrow: async () => {},
    tombstone: async () => {},
    search: async () => ({ ids: [], estimatedTotal: 0 }),
  };
}

const handle = (jwt?: string): Promise<Response> =>
  new Elysia().use(meilisearchBackfillRoutes).handle(
    new Request('http://localhost/api/admin/enrichment/backfill-meilisearch', {
      method: 'POST',
      headers: jwt === undefined ? {} : { authorization: `Bearer ${jwt}` },
    }),
  );

describe('POST /api/admin/enrichment/backfill-meilisearch — owner gate (#2353)', () => {
  it('rejects an unauthenticated request with 401', async () => {
    using live = await createLiveTestDatabase();
    expect((await handle()).status).toBe(401);
  });

  it('rejects a member-role token with 403', async () => {
    using live = await createLiveTestDatabase();
    const response = await handle(memberJwt);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'owner role required' });
  });

  it('allows an owner-role token through to the batch-run path (200)', async () => {
    using live = await createLiveTestDatabase();
    setMeilisearchClientForTests(makeUnconfiguredMeili());
    // Semantic search isn't configured, so the handler 400s — but that's the
    // business-logic path, not the auth gate, confirming the owner token got
    // past `requireOwner`.
    expect((await handle(ownerJwt)).status).toBe(400);
  });
});
