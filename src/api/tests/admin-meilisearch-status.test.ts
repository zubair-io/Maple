/**
 * `GET /api/admin/enrichment/meilisearch-status` — what it reports, who may
 * ask, and how often it does the expensive work.
 *
 * Extracted from `meilisearch-backfill-resilience.test.ts` at the SQLite
 * cutover (#3787): these cases drive the route rather than the backfill, and
 * the route's own port is a separate piece of that work. The coverage numbers
 * come from `countLiveAssets` / `countLiveAssetsWithFingerprint` in
 * `enrichment/meilisearch-vector-coverage.ts`, which replaced the Mongo-era
 * `LIVE_ASSET_FILTER` the route used to compose itself.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import {
  setMeilisearchClientForTests,
  type MeilisearchAssetDoc,
  type MeilisearchClient,
} from '../src/enrichment/meilisearch-client.ts';
import { signAccessToken } from '../src/auth/tokens.ts';
import {
  _resetAdminMeilisearchStatusCacheForTests,
  adminMeilisearchStatusRoutes,
} from '../src/routes/admin-meilisearch-status.ts';
import { createLiveTestDatabase, run } from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { newObjectIdHex } from '../src/db/sqlite/object-id.ts';
import { seedIndexableAsset } from './helpers/meili-backfill-fixtures.ts';

process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

// admin-meilisearch-status is owner-gated (#2353).
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
  _resetAdminMeilisearchStatusCacheForTests();
});

function statusClient(): MeilisearchClient {
  const upserts: MeilisearchAssetDoc[] = [];
  return {
    isConfigured: () => true,
    semanticConfigured: () => true,
    health: async () => true,
    ensureIndex: async () => {},
    upsert: async () => {},
    upsertOrThrow: async () => {},
    upsertBatchOrThrow: async (docs) => {
      upserts.push(...docs);
    },
    tombstone: async () => {},
    tombstoneBatchOrThrow: async () => {},
    search: async () => ({ ids: [], estimatedTotal: 0 }),
  };
}

const request = (jwt?: string): Request =>
  new Request('http://localhost/api/admin/enrichment/meilisearch-status', {
    headers: jwt === undefined ? {} : { authorization: `Bearer ${jwt}` },
  });

const handle = (jwt?: string): Promise<Response> =>
  new Elysia().use(adminMeilisearchStatusRoutes).handle(request(jwt));

describe('GET /api/admin/enrichment/meilisearch-status', () => {
  it('reports confirmed live coverage separately from raw tombstone-inclusive stats', async () => {
    using live = await createLiveTestDatabase();
    const covered = seedIndexableAsset(live.db, { mapleId: 'covered' });
    seedIndexableAsset(live.db, { mapleId: 'pending' });
    const tombstoned = seedIndexableAsset(live.db, {
      mapleId: 'tombstone',
      deletedAt: new Date().toISOString(),
    });
    for (const id of [covered, tombstoned]) {
      run(live.db, `UPDATE assets SET semantic_vector_fingerprint = 'current' WHERE id = ?`, id);
    }

    const meili = statusClient();
    meili.semanticFingerprint = () => 'current';
    meili.semanticStatus = async () => ({
      configured: true,
      enabled: true,
      embedderName: 'caption',
      model: 'bge-m3',
      semanticRatio: 0.5,
      meilisearchReachable: true,
      embedderConfigured: true,
      embedderReachable: true,
      indexedDocumentCount: 3,
      vectorizedDocumentCount: 3,
      isIndexing: false,
      embedderPolicyRejected: false,
      error: null,
    });
    setMeilisearchClientForTests(meili);

    expect(await (await handle(ownerJwt)).json()).toMatchObject({
      documents: {
        live: 2,
        indexedRaw: 3,
        vectorizedRaw: 3,
        vectorizedLive: 1,
        vectorCoverage: 0.5,
      },
    });
  });

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

  it('allows an owner-role token through (200)', async () => {
    using live = await createLiveTestDatabase();
    setMeilisearchClientForTests(statusClient());
    expect((await handle(ownerJwt)).status).toBe(200);
  });

  it('caches the response so a second poll within the TTL does not re-probe Ollama or re-scan the library (#2359)', async () => {
    using live = await createLiveTestDatabase();
    let semanticStatusCalls = 0;
    const meili = statusClient();
    meili.semanticFingerprint = () => null;
    meili.semanticStatus = async () => {
      semanticStatusCalls += 1;
      return {
        configured: true,
        enabled: true,
        embedderName: 'caption',
        model: 'bge-m3',
        semanticRatio: 0.5,
        meilisearchReachable: true,
        embedderConfigured: true,
        embedderReachable: true,
        indexedDocumentCount: 0,
        vectorizedDocumentCount: 0,
        isIndexing: false,
        embedderPolicyRejected: false,
        error: null,
      };
    };
    setMeilisearchClientForTests(meili);

    const first = await handle(ownerJwt);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(semanticStatusCalls).toBe(1);

    // Second poll within the TTL is served from cache — no second probe.
    const second = await handle(ownerJwt);
    expect(second.status).toBe(200);
    expect(semanticStatusCalls).toBe(1);
    expect(await second.json()).toEqual(firstBody);

    // Once the cache is cleared (simulating TTL expiry), the next poll
    // probes again.
    _resetAdminMeilisearchStatusCacheForTests();
    const third = await handle(ownerJwt);
    expect(third.status).toBe(200);
    expect(semanticStatusCalls).toBe(2);
  });
});
