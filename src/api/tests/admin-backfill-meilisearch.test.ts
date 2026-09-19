/**
 * Tests POST /api/admin/enrichment/backfill-meilisearch — sweeps every asset
 * carrying a content-dedup id and upserts it to Meilisearch. The route is
 * owner-gated (#2353) — a `?reset=true` call discards backfill progress and
 * re-scans the whole library, so every request below carries an owner bearer.
 * The member/no-bearer rejection paths are covered in
 * `admin-backfill-meilisearch-owner-gate.test.ts` (split for the file-size
 * budget).
 *
 * Seeding is SQLite (#3787). Two things read differently from the Mongo era
 * and are worth naming:
 *
 *  - The cursor filters on `maple_id IS NOT NULL` alone, so the legacy row
 *    below never enters a batch. That was already true of the Mongo cursor's
 *    observed behaviour — `scanned` was 7, not 8 — so the counts are unchanged.
 *  - A row that cannot be composed is made by giving it a numeric place search
 *    blob (`BROKEN_PLACE`), not a malformed folder id: `asset_locations`
 *    declares a real foreign key, so a library id that is not an id cannot be
 *    stored in the first place.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import {
  setMeilisearchClientForTests,
  type MeilisearchClient,
  type MeilisearchAssetDoc,
} from '../src/enrichment/meilisearch-client.ts';
import { signAccessToken } from '../src/auth/tokens.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  run,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { insertFaceRow, insertPersonRow } from '../src/db/repos/assets.test-helpers.ts';
import { newObjectIdHex } from '../src/db/object-id.ts';
import {
  BROKEN_PLACE,
  failuresByMapleId,
  seedIndexableAsset,
} from './helpers/meili-backfill-fixtures.ts';
import { meilisearchBackfillRoutes } from '../src/routes/admin-backfill-meilisearch.ts';

process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

const ownerJwt = await signAccessToken(
  { file_access: true, sub: newObjectIdHex(), email: 'o@m.c', role: 'owner' },
  'x'.repeat(32),
);

afterEach(() => {
  setMeilisearchClientForTests(null);
});

interface CapturedMeili {
  client: MeilisearchClient;
  upserts: MeilisearchAssetDoc[];
  tombstones: string[];
  ensureCalls: number;
  configured: boolean;
  failBatch: boolean;
}

function makeCapturingMeili(configured = true): CapturedMeili {
  const upserts: MeilisearchAssetDoc[] = [];
  const tombstones: string[] = [];
  const c: CapturedMeili = {
    upserts,
    tombstones,
    ensureCalls: 0,
    configured,
    failBatch: false,
    client: {
      isConfigured: () => c.configured,
      semanticConfigured: () => c.configured,
      health: async () => c.configured,
      ensureIndex: async () => {
        c.ensureCalls += 1;
      },
      upsert: async (doc) => {
        upserts.push(doc);
      },
      upsertOrThrow: async (doc) => {
        upserts.push(doc);
      },
      upsertBatchOrThrow: async (docs) => {
        if (c.failBatch) throw new Error('temporary batch failure');
        upserts.push(...docs);
      },
      tombstoneBatchOrThrow: async (ids) => {
        if (c.failBatch) throw new Error('temporary batch failure');
        tombstones.push(...ids);
      },
      tombstone: async (id) => {
        tombstones.push(id);
      },
      search: async () => ({ ids: [], estimatedTotal: 0 }),
    },
  };
  return c;
}

/** The backfill POST, as an owner, with whatever query string the test needs. */
function backfill(query = ''): Promise<Response> {
  return new Elysia().use(meilisearchBackfillRoutes).handle(
    new Request(`http://localhost/api/admin/enrichment/backfill-meilisearch${query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerJwt}` },
    }),
  );
}

/** A 24-character hex id whose ordering the cursor tests can rely on. */
const orderedId = (n: number): string => String(n).repeat(24);

describe('POST /api/admin/enrichment/backfill-meilisearch', () => {
  it('returns 400 when semantic search is not configured', async () => {
    using live = await createLiveTestDatabase();
    setMeilisearchClientForTests(makeCapturingMeili(false).client);

    const response = await backfill();
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('not enabled');
  });

  it('upserts enriched and filename-only assets and reports counts', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = insertFolder(live.db, { path: '/library' });
    seedIndexableAsset(live.db, { mapleId: 'a', placeSearchBlob: 'albany ny' });
    seedIndexableAsset(live.db, { mapleId: 'b', placeSearchBlob: 'new york ny park' });
    seedIndexableAsset(live.db, { mapleId: 'c', placeSearchBlob: 'san francisco ca' });
    // Filename-only assets are still indexed for exact identifier search.
    seedIndexableAsset(live.db, { mapleId: 'd', placeSearchBlob: '' });
    // A missing place is also valid when the filename is searchable.
    seedIndexableAsset(live.db, { mapleId: 'e' });
    // Skipped before it is ever scanned: no content-dedup id (legacy row).
    seedIndexableAsset(live.db, { mapleId: null });
    // Soft-deleted — the pass tombstones it so Meilisearch drops the document.
    seedIndexableAsset(live.db, {
      mapleId: 'g',
      placeSearchBlob: 'denver co',
      deletedAt: new Date().toISOString(),
    });
    // Its only location has gone missing, which is the same answer.
    seedIndexableAsset(live.db, {
      mapleId: 'h',
      placeSearchBlob: 'stale modern location',
      missingSince: new Date().toISOString(),
    });

    const meili = makeCapturingMeili();
    setMeilisearchClientForTests(meili.client);

    const response = await backfill();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      scanned: number;
      upserted: number;
      tombstoned: number;
      skipped: number;
      errors: number;
    };
    // All seven assets carrying a maple_id are scanned; the legacy row is
    // excluded by the cursor query itself.
    expect(body).toMatchObject({
      scanned: 7,
      upserted: 5,
      tombstoned: 2,
      skipped: 2,
      errors: 0,
    });

    expect(meili.upserts.map((doc) => doc.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    for (const doc of meili.upserts) expect(doc.folderId).toBe(libraryId);
    expect(meili.tombstones.sort()).toEqual(['g', 'h']);

    // ensureIndex was called once at the start.
    expect(meili.ensureCalls).toBe(1);
  });

  it('pushes the FULL doc shape (description / vision / people / searchBlob)', async () => {
    using live = await createLiveTestDatabase();
    insertFolder(live.db, { path: '/library' });
    const personId = insertPersonRow(live.db, 'Greyson');
    const assetId = seedIndexableAsset(live.db, {
      mapleId: 'full',
      description: 'kids playing lacrosse',
      placeSearchBlob: 'albany ny',
    });
    run(
      live.db,
      `UPDATE asset_detail SET vision = ? WHERE asset_id = ?`,
      JSON.stringify({
        caption: 'kids playing lacrosse',
        subjects: ['child', 'athlete'],
        scene_type: 'outdoor',
        setting: 'sports field',
        activity: 'lacrosse',
        notable_objects: ['lacrosse stick'],
        is_screenshot: false,
      }),
      assetId,
    );
    run(live.db, `UPDATE assets SET is_screenshot = 0 WHERE id = ?`, assetId);
    insertFaceRow(live.db, { assetId, personId, confidence: 0.9 });

    const meili = makeCapturingMeili();
    setMeilisearchClientForTests(meili.client);
    expect((await backfill()).status).toBe(200);

    const doc = meili.upserts.find((entry) => entry.id === 'full');
    expect(doc).toBeDefined();
    expect(doc!.description).toBe('kids playing lacrosse');
    expect(doc!.visionSceneType).toBe('outdoor');
    expect(doc!.visionActivity).toBe('lacrosse');
    expect(doc!.visionSubjects).toEqual(['child', 'athlete']);
    expect(doc!.isScreenshot).toBe(false);
    expect(doc!.people).toEqual(['Greyson']);
    // searchBlob is recomposed and includes tokens from every source.
    const tokens = new Set(doc!.searchBlob.split(' '));
    expect(tokens.has('albany')).toBe(true);
    expect(tokens.has('lacrosse')).toBe(true);
    expect(tokens.has('greyson')).toBe(true);
  });

  it('resumes from a durable cursor in bounded batches', async () => {
    using live = await createLiveTestDatabase();
    insertFolder(live.db, { path: '/library' });
    // Explicit ids: the cursor is a keyed range over `assets.id`, so the batch
    // boundary is only predictable when the ids sort the way the test reads.
    seedIndexableAsset(live.db, { id: orderedId(1), mapleId: 'batch-a' });
    seedIndexableAsset(live.db, { id: orderedId(2), mapleId: 'batch-b' });
    seedIndexableAsset(live.db, { id: orderedId(3), mapleId: 'batch-c' });
    const meili = makeCapturingMeili();
    setMeilisearchClientForTests(meili.client);

    const firstBody = (await (await backfill('?batchSize=2')).json()) as {
      complete: boolean;
      nextCursor: string | null;
      cumulative: { scanned: number };
    };
    expect(firstBody.complete).toBe(false);
    expect(firstBody.nextCursor).toBe(orderedId(2));
    expect(firstBody.cumulative.scanned).toBe(2);

    const secondBody = (await (await backfill('?batchSize=2')).json()) as {
      complete: boolean;
      nextCursor: string | null;
      cumulative: { scanned: number; upserted: number };
    };
    expect(secondBody.complete).toBe(true);
    expect(secondBody.nextCursor).toBeNull();
    expect(secondBody.cumulative.scanned).toBe(3);
    expect(secondBody.cumulative.upserted).toBe(3);
    expect(meili.upserts.map((doc) => doc.id).sort()).toEqual(['batch-a', 'batch-b', 'batch-c']);
  });

  it('dead-letters a deterministic row error and advances the cursor', async () => {
    using live = await createLiveTestDatabase();
    insertFolder(live.db, { path: '/library' });
    seedIndexableAsset(live.db, { mapleId: 'broken-row', placeSearchBlob: BROKEN_PLACE });
    setMeilisearchClientForTests(makeCapturingMeili().client);

    const body = (await (await backfill()).json()) as {
      complete: boolean;
      errors: number;
      nextCursor: string | null;
    };
    expect(body.complete).toBe(true);
    expect(body.errors).toBe(1);
    expect(body.nextCursor).toBeNull();
    // `complete` in this same call also runs the end-of-run redrive pass. The
    // row's place blob is still a number, so the immediate re-attempt fails the
    // same way and `attempts` reflects both tries.
    expect(failuresByMapleId(live.db).get('broken-row')).toEqual({ attempts: 2 });
  });

  it('retains the cursor and retries an idempotent batch after a write failure', async () => {
    using live = await createLiveTestDatabase();
    insertFolder(live.db, { path: '/library' });
    seedIndexableAsset(live.db, { id: orderedId(1), mapleId: 'retry-a' });
    seedIndexableAsset(live.db, { id: orderedId(2), mapleId: 'retry-b' });
    const meili = makeCapturingMeili();
    meili.failBatch = true;
    setMeilisearchClientForTests(meili.client);

    const failedBody = (await (await backfill('?batchSize=10')).json()) as {
      complete: boolean;
      nextCursor: string | null;
      errors: number;
      retryableError: string | null;
      cumulative: { scanned: number; skipped: number; errors: number };
    };
    expect(failedBody.complete).toBe(false);
    expect(failedBody.nextCursor).toBeNull();
    expect(failedBody.errors).toBe(1);
    expect(failedBody.retryableError).toBe('temporary batch failure');
    expect(failedBody.cumulative).toMatchObject({ scanned: 0, skipped: 0, errors: 0 });
    expect(meili.upserts).toHaveLength(0);

    const { backfillMeilisearchVectors } =
      await import('../src/workers/migration/backfill-meilisearch-vectors.ts');
    await expect(backfillMeilisearchVectors.runBatch(10)).rejects.toThrow(
      'Cause: temporary batch failure',
    );

    meili.failBatch = false;
    const retriedBody = (await (await backfill('?batchSize=10')).json()) as {
      complete: boolean;
      upserted: number;
      cumulative: { scanned: number; upserted: number; skipped: number; errors: number };
    };
    expect(retriedBody.complete).toBe(true);
    expect(retriedBody.upserted).toBe(2);
    expect(retriedBody.cumulative).toMatchObject({
      scanned: 2,
      upserted: 2,
      skipped: 0,
      errors: 0,
    });
    expect(meili.upserts.map((doc) => doc.id).sort()).toEqual(['retry-a', 'retry-b']);
  });
});

// The migration-adapter tests (durable progress/reset, dead-letter backlog
// count) live in `admin-backfill-meilisearch-migration.test.ts` — split for
// the file-size budget.
