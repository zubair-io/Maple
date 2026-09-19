/**
 * `enrichment_state` dead-letter triage through the repository.
 *
 * The cases worth pinning are the ones an operator would notice: the list is
 * newest-first and carries a resolvable path, the histogram buckets long errors
 * by their shared head, and a reset never touches a row that is not actually
 * parked — clearing `attempts` on an asset a worker is processing would hand it
 * a fresh retry budget it did not earn.
 */

import { describe, expect, test } from 'bun:test';
import {
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  testSqliteDb,
} from '../sqlite/test-sqlite.test-helpers.ts';
import { insertEnrichmentState } from './assets.test-helpers.ts';
import { clearDeadLetter, groupDeadLettered, listDeadLettered } from './enrichment-state.repo.ts';

describe('listDeadLettered', () => {
  test('returns only parked rows for the stage, newest first', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const older = insertAsset(db);
    const newer = insertAsset(db);
    const live = insertAsset(db);
    const otherStage = insertAsset(db);

    insertEnrichmentState(db, older, 'geocode', { deadLetterAt: '2026-01-01T00:00:00Z' });
    insertEnrichmentState(db, newer, 'geocode', { deadLetterAt: '2026-02-01T00:00:00Z' });
    insertEnrichmentState(db, live, 'geocode', { attempts: 2 });
    insertEnrichmentState(db, otherStage, 'face', { deadLetterAt: '2026-03-01T00:00:00Z' });

    const rows = await listDeadLettered('geocode', 50, testSqliteDb(db));
    expect(rows.map((row) => row.asset_id)).toEqual([newer, older]);
  });

  test('honours the limit', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    for (let i = 0; i < 5; i += 1) {
      insertEnrichmentState(db, insertAsset(db), 'geocode', {
        deadLetterAt: `2026-01-0${i + 1}T00:00:00Z`,
      });
    }
    expect(await listDeadLettered('geocode', 2, testSqliteDb(db))).toHaveLength(2);
  });

  test('resolves the absolute path of the primary live location', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertFolder(db, { path: '/photos' });
    const assetId = insertAsset(db);
    insertLocation(db, { assetId, libraryId: library, path: 'trips/2026', filename: 'a.dng' });
    insertEnrichmentState(db, assetId, 'geocode', {
      deadLetterAt: '2026-01-01T00:00:00Z',
      lastError: 'nominatim timeout',
      attempts: 5,
    });

    const [row] = await listDeadLettered('geocode', 50, testSqliteDb(db));
    expect(row).toEqual({
      asset_id: assetId,
      abs_path: '/photos/trips/2026/a.dng',
      last_error: 'nominatim timeout',
      attempts: 5,
      dead_letter_at: '2026-01-01T00:00:00Z',
    });
  });

  test('still lists a row whose locations are all gone, with a null path', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertFolder(db);
    const assetId = insertAsset(db);
    // An operator has to be able to clear this one even though nothing on disk
    // backs it any more.
    insertLocation(db, { assetId, libraryId: library, missingSince: '2026-01-01T00:00:00Z' });
    insertEnrichmentState(db, assetId, 'geocode', { deadLetterAt: '2026-01-01T00:00:00Z' });

    const [row] = await listDeadLettered('geocode', 50, testSqliteDb(db));
    expect(row?.abs_path).toBeNull();
  });
});

describe('groupDeadLettered', () => {
  test('buckets by the truncated error head, biggest bucket first', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const head = 'nominatim 503 ';
    for (const suffix of ['alpha', 'beta', 'gamma']) {
      insertEnrichmentState(db, insertAsset(db), 'geocode', {
        deadLetterAt: `2026-01-01T00:00:0${suffix.length}Z`,
        lastError: head + suffix,
      });
    }
    insertEnrichmentState(db, insertAsset(db), 'geocode', {
      deadLetterAt: '2026-01-02T00:00:00Z',
      lastError: 'dns failure',
    });

    // A truncation length shorter than the varying tail collapses the three.
    const groups = await groupDeadLettered('geocode', head.length, testSqliteDb(db));
    expect(groups).toEqual([
      { errorClass: head, count: 3, latestTs: '2026-01-01T00:00:05Z' },
      { errorClass: 'dns failure', count: 1, latestTs: '2026-01-02T00:00:00Z' },
    ]);
  });

  test('collapses rows with no error into one bucket rather than failing', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    insertEnrichmentState(db, insertAsset(db), 'geocode', {
      deadLetterAt: '2026-01-01T00:00:00Z',
    });
    insertEnrichmentState(db, insertAsset(db), 'geocode', {
      deadLetterAt: '2026-01-02T00:00:00Z',
    });

    const groups = await groupDeadLettered('geocode', 80, testSqliteDb(db));
    expect(groups).toEqual([{ errorClass: '', count: 2, latestTs: '2026-01-02T00:00:00Z' }]);
  });
});

describe('clearDeadLetter', () => {
  test('clears every parked row for the stage and leaves other stages alone', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const assetId = insertAsset(db);
    insertEnrichmentState(db, assetId, 'geocode', {
      deadLetterAt: '2026-01-01T00:00:00Z',
      lastError: 'boom',
      attempts: 5,
    });
    insertEnrichmentState(db, assetId, 'face', {
      deadLetterAt: '2026-01-01T00:00:00Z',
      attempts: 5,
    });

    expect(await clearDeadLetter('geocode', undefined, testSqliteDb(db))).toBe(1);
    expect(await listDeadLettered('geocode', 50, testSqliteDb(db))).toEqual([]);
    expect(await listDeadLettered('face', 50, testSqliteDb(db))).toHaveLength(1);

    const [cleared] = db
      .query(
        `SELECT attempts, last_error, dead_letter_at FROM enrichment_state
          WHERE asset_id = ? AND stage = 'geocode'`,
      )
      .all(assetId) as Array<{ attempts: number; last_error: string | null; dead_letter_at: null }>;
    expect(cleared).toEqual({ attempts: 0, last_error: null, dead_letter_at: null });
  });

  test('targets one asset when given an id', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const mine = insertAsset(db);
    const other = insertAsset(db);
    insertEnrichmentState(db, mine, 'geocode', { deadLetterAt: '2026-01-01T00:00:00Z' });
    insertEnrichmentState(db, other, 'geocode', { deadLetterAt: '2026-01-01T00:00:00Z' });

    expect(await clearDeadLetter('geocode', mine, testSqliteDb(db))).toBe(1);
    const rows = await listDeadLettered('geocode', 50, testSqliteDb(db));
    expect(rows.map((row) => row.asset_id)).toEqual([other]);
  });

  test('will not reset an asset that is not dead-lettered', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const assetId = insertAsset(db);
    // A row a worker is retrying right now: clearing its attempts would hand it
    // a retry budget it has already spent.
    insertEnrichmentState(db, assetId, 'geocode', { attempts: 3, lastError: 'transient' });

    expect(await clearDeadLetter('geocode', assetId, testSqliteDb(db))).toBe(0);
    const [row] = db
      .query(`SELECT attempts FROM enrichment_state WHERE asset_id = ?`)
      .all(assetId) as Array<{ attempts: number }>;
    expect(row?.attempts).toBe(3);
  });

  test('reports zero for an id that names nothing', async () => {
    using handle = await createTestDatabase();
    expect(await clearDeadLetter('geocode', 'not-a-hex-id', testSqliteDb(handle.db))).toBe(0);
  });
});
