/**
 * change-log-gc tests (#3787).
 *
 * Every case runs against its own SQLite database and drives the sweep through
 * the `dbOverride` the worker already forwards to each repository call, so the
 * suite is green with no service running anywhere.
 *
 * Journal rows are made with `recordAssetChange` and then backdated. There is
 * no cursor to allocate by hand: allocation is part of the insert — the counter
 * bump and the row go in as one batch and the insert's rowid *is* the cursor —
 * so a test that wrote rows any other way would be testing a shape production
 * never produces. `allocatedCursor` reads the counter; it does not allocate.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  allocatedCursor,
  isChangeCursorTooOld,
  recordAssetChange,
} from '../db/repos/changes.repo.ts';
import { countChanges, findRetentionCutoffCursor } from '../db/repos/changes.retention.ts';
import type { SqliteDb } from '../db/repos/db-handle.ts';
import { createTestDatabase, run, testSqliteDb } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { loadChangeLogGcConfig, saveChangeLogGcConfig } from './change-log-gc-config.repo.ts';
import { runChangeLogGcOnce, startChangeLogGc } from './change-log-gc.ts';

const DAY_MS = 86_400_000;

/** Write one journal row the way production does, then age it. */
async function journalRow(db: SqliteDb, raw: Database, ageDays: number): Promise<number> {
  const cursor = await recordAssetChange(db, {
    kind: 'update',
    asset_id: null,
    folder_id: null,
    abs_path: `/p/${ageDays}.dng`,
  });
  run(
    raw,
    `UPDATE asset_changes SET at = ? WHERE cursor = ?`,
    new Date(Date.now() - ageDays * DAY_MS).toISOString(),
    cursor,
  );
  return cursor;
}

/** `count` rows of the same age, in allocation order. */
async function journalRows(
  db: SqliteDb,
  raw: Database,
  count: number,
  ageDays: number,
): Promise<number[]> {
  const cursors: number[] = [];
  for (let i = 0; i < count; i++) cursors.push(await journalRow(db, raw, ageDays));
  return cursors;
}

function remainingCursors(raw: Database): number[] {
  return (
    raw.query(`SELECT cursor FROM asset_changes ORDER BY cursor`).all() as Array<{
      cursor: number;
    }>
  ).map((row) => row.cursor);
}

describe('findRetentionCutoffCursor', () => {
  it('returns null on an empty journal', async () => {
    using handle = await createTestDatabase();
    expect(await findRetentionCutoffCursor(new Date(), testSqliteDb(handle.db))).toBeNull();
  });

  it('returns null when every row is newer than the cutoff', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await journalRow(db, handle.db, 5);
    await journalRow(db, handle.db, 2);

    expect(await findRetentionCutoffCursor(new Date(Date.now() - 10 * DAY_MS), db)).toBeNull();
  });

  it('returns the highest cursor when every row is older than the cutoff', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await journalRow(db, handle.db, 40);
    const newest = await journalRow(db, handle.db, 35);

    expect(await findRetentionCutoffCursor(new Date(Date.now() - 30 * DAY_MS), db)).toBe(newest);
  });

  it('finds the boundary cursor by bisection across mixed rows', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    // Ten rows, ageing from 38 days down to 20: the first five predate a
    // 29-day cutoff and the rest do not, so the boundary is the fifth.
    const cursors: number[] = [];
    for (let i = 1; i <= 10; i++) cursors.push(await journalRow(db, handle.db, 40 - i * 2));

    expect(await findRetentionCutoffCursor(new Date(Date.now() - 29 * DAY_MS), db)).toBe(
      cursors[4],
    );
  });
});

describe('runChangeLogGcOnce', () => {
  it('deletes rows older than the cutoff in bounded batches and retains newer ones', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const old = await journalRows(db, handle.db, 6, 40);
    const fresh = await journalRows(db, handle.db, 4, 5);

    const summary = await runChangeLogGcOnce({ retentionDays: 30, batchSize: 2, dbOverride: db });
    expect(summary.deleted).toBe(6);
    expect(summary.batches).toBe(3);
    expect(summary.cutoffCursor).toBe(old[5]!);
    expect(summary.prunedThrough).toBe(old[5]!);
    expect(summary.remaining).toBe(4);

    expect(remainingCursors(handle.db)).toEqual(fresh);
  });

  it('leaves the allocation counter standing so a swept journal still answers 409', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const pruned = await journalRow(db, handle.db, 40);
    expect(await allocatedCursor(db)).toBe(pruned);

    const summary = await runChangeLogGcOnce({ retentionDays: 30, dbOverride: db });
    expect(summary.deleted).toBe(1);
    expect(await countChanges(db)).toBe(0);

    // The counter is not in the journal, so emptying the journal cannot rewind
    // it — the next allocation continues past the cursor that was pruned.
    expect(await allocatedCursor(db)).toBe(pruned);
    expect(await journalRow(db, handle.db, 0)).toBe(pruned + 1);

    // Which is what lets a client holding a pruned cursor be told to
    // re-enumerate instead of being handed a 200 over an empty stream.
    expect(await isChangeCursorTooOld(db, pruned - 1)).toEqual({
      tooOld: true,
      current: pruned + 1,
    });
  });

  it('is idempotent on an empty journal and when nothing has expired', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);

    const empty = await runChangeLogGcOnce({ retentionDays: 30, dbOverride: db });
    expect(empty.deleted).toBe(0);
    expect(empty.batches).toBe(0);
    expect(empty.cutoffCursor).toBeNull();

    const fresh = await journalRow(db, handle.db, 0);
    const second = await runChangeLogGcOnce({ retentionDays: 30, dbOverride: db });
    expect(second.deleted).toBe(0);
    expect(remainingCursors(handle.db)).toEqual([fresh]);
  });

  it('stops mid-sweep when shouldStop signals cooperative cancellation', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await journalRows(db, handle.db, 6, 40);

    let checks = 0;
    const summary = await runChangeLogGcOnce({
      retentionDays: 30,
      batchSize: 2,
      dbOverride: db,
      shouldStop: () => {
        checks++;
        return checks > 1; // stop after the first batch
      },
    });

    expect(summary.batches).toBe(1);
    expect(summary.deleted).toBe(2);
    expect(await countChanges(db)).toBe(4);
  });

  it('skips the sweep when the config is disabled', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await saveChangeLogGcConfig({ enabled: false }, db);
    await journalRow(db, handle.db, 40);

    const summary = await runChangeLogGcOnce({ dbOverride: db });
    expect(summary.skipped).toBe(true);
    expect(summary.deleted).toBe(0);
    expect(await countChanges(db)).toBe(1);
  });

  it('persists last_run telemetry after a pass', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const pruned = await journalRow(db, handle.db, 40);

    const summary = await runChangeLogGcOnce({ retentionDays: 30, dbOverride: db });
    expect(summary.deleted).toBe(1);

    const config = await loadChangeLogGcConfig(db);
    expect(config.last_run).not.toBeNull();
    expect(config.last_run?.deleted).toBe(1);
    expect(config.last_run?.batches).toBe(1);
    expect(config.last_run?.pruned_through).toBe(pruned);
    expect(config.last_run?.remaining).toBe(0);
  });
});

describe('startChangeLogGc', () => {
  it('returns a handle that stops the interval', async () => {
    using handle = await createTestDatabase();
    const gc = startChangeLogGc({ intervalMs: 10_000, dbOverride: testSqliteDb(handle.db) });
    expect(typeof gc.stop).toBe('function');
    gc.stop();
    // The boot pass fires immediately and outlives `stop()`; let it finish
    // before the block disposes the database out from under it.
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
});
