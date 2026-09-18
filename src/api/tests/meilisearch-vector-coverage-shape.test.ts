/**
 * Vector-coverage carry-forward across a document-shape change (#2384).
 *
 * The pure prefix parsing is unit-tested in
 * `src/enrichment/meilisearch-vector-coverage.test.ts`, and the SQL behind the
 * update in `src/db/sqlite/repos/assets.meilisearch.test.ts`. This file drives
 * the entry point the rest of the server calls, because that is where a mistake
 * would hide: `advanceKnownVectorCoverage` runs unconditionally on every boot
 * (`meilisearch-http-bootstrap.ts`), so a too-permissive filter silently marks
 * the whole library as vectorized under a template it was never embedded with —
 * 100% coverage over empty transcripts, and nothing left for the operator to
 * backfill.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createLiveTestDatabase, run } from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { advanceKnownVectorCoverage } from '../src/enrichment/meilisearch-vector-coverage.ts';
import { seedIndexableAsset } from './helpers/meili-backfill-fixtures.ts';

/** A live asset carrying a given stored fingerprint. */
function seedCovered(db: Database, mapleId: string, fingerprint: string | null): void {
  const id = seedIndexableAsset(db, { mapleId });
  if (fingerprint === null) return;
  run(db, `UPDATE assets SET semantic_vector_fingerprint = ? WHERE id = ?`, fingerprint, id);
}

function storedFingerprints(db: Database): Record<string, string | null> {
  const rows = db
    .query(`SELECT maple_id, semantic_vector_fingerprint AS fp FROM assets`)
    .all() as Array<{ maple_id: string; fp: string | null }>;
  return Object.fromEntries(rows.map((row) => [row.maple_id, row.fp]));
}

describe('advanceKnownVectorCoverage — document-shape gate', () => {
  it('carries coverage forward within one shape but not across a shape change', async () => {
    using live = await createLiveTestDatabase();
    // Same shape as the incoming fingerprint — model/url changed only.
    seedCovered(live.db, 'same-shape', 'v8:oldhash');
    // Previous document shape — its vectors were built without the fields
    // the new template reads.
    seedCovered(live.db, 'older-shape', 'v7:oldhash');
    // Pre-#2384 bare-sha256 fingerprint.
    seedCovered(live.db, 'legacy-unprefixed', 'deadbeef');
    // Never vectorized.
    seedCovered(live.db, 'never-covered', null);

    await advanceKnownVectorCoverage('v8:newhash');

    const after = storedFingerprints(live.db);
    expect(after['same-shape']).toBe('v8:newhash');
    expect(after['older-shape']).toBe('v7:oldhash');
    expect(after['legacy-unprefixed']).toBe('deadbeef');
    expect(after['never-covered']).toBeNull();
  });

  it('is a no-op for an unprefixed incoming fingerprint', async () => {
    using live = await createLiveTestDatabase();
    seedCovered(live.db, 'some-row', 'v8:oldhash');

    await advanceKnownVectorCoverage('bare-hash-no-prefix');

    expect(storedFingerprints(live.db)['some-row']).toBe('v8:oldhash');
  });

  it('leaves trashed rows alone even when their shape matches', async () => {
    using live = await createLiveTestDatabase();
    const id = seedIndexableAsset(live.db, {
      mapleId: 'trashed',
      deletedAt: '2026-01-01T00:00:00Z',
    });
    run(live.db, `UPDATE assets SET semantic_vector_fingerprint = 'v8:oldhash' WHERE id = ?`, id);

    await advanceKnownVectorCoverage('v8:newhash');

    expect(storedFingerprints(live.db)['trashed']).toBe('v8:oldhash');
  });
});
