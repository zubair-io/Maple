/**
 * The vector backfill's three tables through the repository.
 *
 * The behaviours worth pinning are the ones a run depends on rather than the
 * plain round trips: that counters accumulate instead of being overwritten, that
 * a second runner is refused while a live lease is held and admitted once it
 * expires, and that a repeat failure for the same asset increments one row
 * rather than adding a second.
 */

import { describe, expect, test } from 'bun:test';
import {
  createTestDatabase,
  insertAsset,
  testSqliteDb,
} from '../sqlite/test-sqlite.test-helpers.ts';
import {
  acquireBackfillLease,
  advanceBackfillState,
  clearBackfillRetry,
  countBackfillFailures,
  deleteBackfillFailures,
  deleteBackfillState,
  insertBackfillState,
  listOldestBackfillFailures,
  readBackfillState,
  recordBackfillFailure,
  recordBackfillRetry,
  releaseBackfillLease,
  renewBackfillLease,
  setBackfillRemaining,
} from './meilisearch-backfill.repo.ts';

const START = '2026-01-01T00:00:00.000Z';

function freshState(remaining = 10): Parameters<typeof insertBackfillState>[0] {
  return { remaining, startedAt: START, docShapeVersion: 8 };
}

describe('backfill state', () => {
  test('reads back nothing before a generation is started', async () => {
    using handle = await createTestDatabase();
    expect(await readBackfillState(testSqliteDb(handle.db))).toBeNull();
  });

  test('a fresh generation starts at zero with the cursor unset', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await insertBackfillState(freshState(42), db);

    expect(await readBackfillState(db)).toEqual({
      cursor: null,
      scanned: 0,
      upserted: 0,
      tombstoned: 0,
      skipped: 0,
      errors: 0,
      remaining: 42,
      retry_attempts: 0,
      retry_error: null,
      blocked_at: null,
      started_at: START,
      updated_at: START,
      completed_at: null,
      doc_shape_version: 8,
    });
  });

  test('starting a generation over an existing one resets its progress', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await insertBackfillState(freshState(), db);
    await advanceBackfillState(
      {
        cursor: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        updatedAt: '2026-01-02T00:00:00.000Z',
        complete: true,
        remaining: 0,
        scanned: 5,
        upserted: 4,
        tombstoned: 1,
        skipped: 0,
        errors: 0,
      },
      db,
    );

    await insertBackfillState({ remaining: 7, startedAt: START, docShapeVersion: 9 }, db);
    const state = await readBackfillState(db);
    expect(state).toMatchObject({
      cursor: null,
      scanned: 0,
      upserted: 0,
      tombstoned: 0,
      remaining: 7,
      completed_at: null,
      doc_shape_version: 9,
    });
  });

  test('a batch adds to the stored totals rather than replacing them', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await insertBackfillState(freshState(10), db);
    const batch = {
      updatedAt: '2026-01-02T00:00:00.000Z',
      complete: false,
      scanned: 3,
      upserted: 2,
      tombstoned: 1,
      skipped: 0,
      errors: 0,
    };
    await advanceBackfillState({ ...batch, cursor: 'a'.repeat(24), remaining: 7 }, db);
    await advanceBackfillState({ ...batch, cursor: 'b'.repeat(24), remaining: 4 }, db);

    expect(await readBackfillState(db)).toMatchObject({
      cursor: 'b'.repeat(24),
      scanned: 6,
      upserted: 4,
      tombstoned: 2,
      remaining: 4,
      completed_at: null,
    });
  });

  test('a completing batch stamps completed_at with its own instant', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await insertBackfillState(freshState(3), db);
    await advanceBackfillState(
      {
        cursor: 'c'.repeat(24),
        updatedAt: '2026-01-03T00:00:00.000Z',
        complete: true,
        remaining: 0,
        scanned: 3,
        upserted: 3,
        tombstoned: 0,
        skipped: 0,
        errors: 0,
      },
      db,
    );
    expect(await readBackfillState(db)).toMatchObject({
      completed_at: '2026-01-03T00:00:00.000Z',
      remaining: 0,
    });
  });

  test('a landed batch clears the retry circuit a previous failure engaged', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await insertBackfillState(freshState(), db);
    await recordBackfillRetry(
      {
        attempts: 5,
        error: 'meilisearch unreachable',
        blockedAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      db,
    );
    expect(await readBackfillState(db)).toMatchObject({
      retry_attempts: 5,
      retry_error: 'meilisearch unreachable',
      blocked_at: '2026-01-02T00:00:00.000Z',
    });

    await advanceBackfillState(
      {
        cursor: 'd'.repeat(24),
        updatedAt: '2026-01-03T00:00:00.000Z',
        complete: false,
        remaining: 1,
        scanned: 1,
        upserted: 1,
        tombstoned: 0,
        skipped: 0,
        errors: 0,
      },
      db,
    );
    expect(await readBackfillState(db)).toMatchObject({
      retry_attempts: 0,
      retry_error: null,
      blocked_at: null,
    });
  });

  test('clearing the retry circuit preserves the cursor and the progress', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await insertBackfillState(freshState(), db);
    await advanceBackfillState(
      {
        cursor: 'e'.repeat(24),
        updatedAt: '2026-01-02T00:00:00.000Z',
        complete: false,
        remaining: 5,
        scanned: 5,
        upserted: 5,
        tombstoned: 0,
        skipped: 0,
        errors: 0,
      },
      db,
    );
    await recordBackfillRetry({ attempts: 5, error: 'down', blockedAt: 'x', updatedAt: 'x' }, db);

    await clearBackfillRetry('2026-01-04T00:00:00.000Z', db);
    expect(await readBackfillState(db)).toMatchObject({
      cursor: 'e'.repeat(24),
      scanned: 5,
      retry_attempts: 0,
      blocked_at: null,
      updated_at: '2026-01-04T00:00:00.000Z',
    });
  });

  test('setBackfillRemaining fills in a counter a pre-#2384 row never had', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await insertBackfillState(freshState(), db);
    await handle.db.run(`UPDATE meilisearch_backfill_state SET remaining = NULL`);

    await setBackfillRemaining(99, db);
    expect((await readBackfillState(db))?.remaining).toBe(99);
  });

  test('deleting the generation leaves nothing to resume', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await insertBackfillState(freshState(), db);
    await deleteBackfillState(db);
    expect(await readBackfillState(db)).toBeNull();
  });
});

describe('backfill lease', () => {
  test('the first caller takes it and a second is refused', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const now = 1_000_000;
    expect(await acquireBackfillLease('runner-a', now + 60_000, now, db)).toBe(true);
    expect(await acquireBackfillLease('runner-b', now + 60_000, now, db)).toBe(false);
  });

  test('the holder can re-take its own lease', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const now = 1_000_000;
    await acquireBackfillLease('runner-a', now + 60_000, now, db);
    expect(await acquireBackfillLease('runner-a', now + 120_000, now, db)).toBe(true);
  });

  test('an expired lease is claimable by somebody else', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const now = 1_000_000;
    await acquireBackfillLease('runner-a', now + 60_000, now, db);
    const later = now + 60_001;
    expect(await acquireBackfillLease('runner-b', later + 60_000, later, db)).toBe(true);
  });

  test('a heartbeat pushes the expiry out, keeping a rival locked out', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const now = 1_000_000;
    await acquireBackfillLease('runner-a', now + 60_000, now, db);
    await renewBackfillLease('runner-a', now + 300_000, db);

    const later = now + 60_001;
    expect(await acquireBackfillLease('runner-b', later + 60_000, later, db)).toBe(false);
  });

  test('a heartbeat from a stale owner does not extend somebody else’s lease', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const now = 1_000_000;
    await acquireBackfillLease('runner-a', now + 60_000, now, db);
    await renewBackfillLease('runner-b', now + 900_000, db);

    const later = now + 60_001;
    expect(await acquireBackfillLease('runner-b', later + 60_000, later, db)).toBe(true);
  });

  test('releasing frees the lease, and a stale release does not', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const now = 1_000_000;
    await acquireBackfillLease('runner-a', now + 60_000, now, db);

    await releaseBackfillLease('runner-b', db);
    expect(await acquireBackfillLease('runner-b', now + 60_000, now, db)).toBe(false);

    await releaseBackfillLease('runner-a', db);
    expect(await acquireBackfillLease('runner-b', now + 60_000, now, db)).toBe(true);
  });
});

describe('backfill failures', () => {
  test('a repeat failure increments one row instead of adding a second', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = insertAsset(handle.db);

    await recordBackfillFailure(
      { assetId, mapleId: 'maple-1', error: 'first', updatedAt: '2026-01-01T00:00:00.000Z' },
      db,
    );
    await recordBackfillFailure(
      { assetId, mapleId: 'maple-1', error: 'second', updatedAt: '2026-01-02T00:00:00.000Z' },
      db,
    );

    expect(await countBackfillFailures(db)).toBe(1);
    expect(await listOldestBackfillFailures(10, db)).toEqual([
      {
        asset_id: assetId,
        maple_id: 'maple-1',
        error: 'second',
        attempts: 2,
        updated_at: '2026-01-02T00:00:00.000Z',
      },
    ]);
  });

  test('the list is oldest-first, which is what bounds the redrive loop', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const first = insertAsset(handle.db);
    const second = insertAsset(handle.db);
    await recordBackfillFailure(
      { assetId: second, mapleId: 'm2', error: 'e', updatedAt: '2026-02-01T00:00:00.000Z' },
      db,
    );
    await recordBackfillFailure(
      { assetId: first, mapleId: 'm1', error: 'e', updatedAt: '2026-01-01T00:00:00.000Z' },
      db,
    );

    const rows = await listOldestBackfillFailures(10, db);
    expect(rows.map((row) => row.asset_id)).toEqual([first, second]);
  });

  test('resolved rows are cleared, and an empty list is a no-op', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const kept = insertAsset(handle.db);
    const resolved = insertAsset(handle.db);
    for (const assetId of [kept, resolved]) {
      await recordBackfillFailure(
        { assetId, mapleId: assetId, error: 'e', updatedAt: '2026-01-01T00:00:00.000Z' },
        db,
      );
    }

    await deleteBackfillFailures([], db);
    expect(await countBackfillFailures(db)).toBe(2);

    await deleteBackfillFailures([resolved], db);
    expect((await listOldestBackfillFailures(10, db)).map((row) => row.asset_id)).toEqual([kept]);
  });

  test('a failure whose asset is deleted goes with it — it is work, not history', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = insertAsset(handle.db);
    await recordBackfillFailure(
      { assetId, mapleId: 'm', error: 'e', updatedAt: '2026-01-01T00:00:00.000Z' },
      db,
    );

    handle.db.run(`DELETE FROM assets WHERE id = ?`, [assetId]);
    expect(await countBackfillFailures(db)).toBe(0);
  });
});
