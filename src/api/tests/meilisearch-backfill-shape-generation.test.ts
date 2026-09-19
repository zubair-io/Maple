/**
 * Backfill generation reset on a document-shape change (#2384).
 *
 * `runBackfillBatch` short-circuits on `state.completed_at`, so a deployment
 * whose previous backfill finished would treat the v8 migration as already
 * done and re-upsert nothing — the operator sees "complete" and the index
 * silently keeps v7 documents. The stored shape version makes the state
 * self-invalidating so nobody has to remember to pass `reset=true`.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createLiveTestDatabase, run } from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { loadBackfillStateForTests } from '../src/enrichment/meilisearch-backfill.ts';
import { ASSET_DOC_SHAPE_VERSION } from '../src/enrichment/meilisearch-embedder-template.ts';

/** A stored generation, as an earlier run would have left it. */
function seedState(
  db: Database,
  state: {
    scanned?: number;
    upserted?: number;
    completedAt?: string | null;
    docShapeVersion?: number | null;
  },
): void {
  run(
    db,
    `INSERT INTO meilisearch_backfill_state
       (id, cursor, scanned, upserted, skipped, errors, started_at, updated_at,
        completed_at, doc_shape_version)
     VALUES ('assets', NULL, ?, ?, 0, 0, ?, ?, ?, ?)`,
    state.scanned ?? 0,
    state.upserted ?? 0,
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    state.completedAt ?? null,
    state.docShapeVersion ?? null,
  );
}

describe('backfill state generation', () => {
  it('discards a completed state written under an older document shape', async () => {
    using live = await createLiveTestDatabase();
    seedState(live.db, {
      scanned: 999,
      upserted: 999,
      completedAt: '2026-01-01T00:00:00.000Z',
      docShapeVersion: ASSET_DOC_SHAPE_VERSION - 1,
    });

    const state = await loadBackfillStateForTests(false);

    expect(state.completed_at).toBeNull();
    expect(state.scanned).toBe(0);
    expect(state.doc_shape_version).toBe(ASSET_DOC_SHAPE_VERSION);
  });

  it('discards a completed state that predates shape stamping', async () => {
    using live = await createLiveTestDatabase();
    seedState(live.db, { scanned: 5, upserted: 5, completedAt: '2026-01-01T00:00:00.000Z' });

    expect((await loadBackfillStateForTests(false)).completed_at).toBeNull();
  });

  it('resumes an in-progress state of the current shape', async () => {
    using live = await createLiveTestDatabase();
    seedState(live.db, { scanned: 42, upserted: 42, docShapeVersion: ASSET_DOC_SHAPE_VERSION });

    expect((await loadBackfillStateForTests(false)).scanned).toBe(42);
  });

  it('stamps the current shape on a brand-new state', async () => {
    using live = await createLiveTestDatabase();
    expect((await loadBackfillStateForTests(false)).doc_shape_version).toBe(
      ASSET_DOC_SHAPE_VERSION,
    );
  });
});
