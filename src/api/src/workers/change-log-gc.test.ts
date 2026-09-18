import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ObjectId, type Db } from 'mongodb';
import { closeDb, getDb, isDbConnected } from '../db/client.ts';
import { withTestDb } from '../db/test-db.test-helpers.ts';
import { allocateCursor, prunedThroughCursor } from '../db/changes.repo.ts';
import { runChangeLogGcOnce } from './change-log-gc.ts';
import { loadChangeLogGcConfig, saveChangeLogGcConfig } from './change-log-gc-config.repo.ts';

// Own per-pid database + explicit close — the repo-wide suite convention
// (#2835). Without it this file prunes whatever database MAPLE_MONGO_DB
// happens to name, which during a full run can be a real one.
withTestDb(`maple_test_change_log_gc_${process.pid}`);

const DAY_MS = 86_400_000;

let db: Db | null = null;
let mongoReachable = false;

beforeAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  try {
    db = await getDb();
    mongoReachable = isDbConnected();
  } catch {
    mongoReachable = false;
    return;
  }
  if (!db) return;
  await db.collection('asset_changes').deleteMany({});
  await db.collection('server_state').deleteMany({});
  await db.collection('worker_config').deleteMany({});
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  await closeDb();
});

/**
 * Insert a change row whose `_id` encodes `daysAgo`. The sweep filters on the
 * `_id` index (an ObjectId's leading bytes are its insert time), so a row's
 * apparent age IS its `_id` timestamp — writing them this way exercises the
 * real predicate rather than a test-only one.
 */
let idNonce = 0;
/** An ObjectId whose timestamp bytes say `seconds` and whose remaining bytes
 * are unique. `ObjectId.createFromTime` zeroes those, so two rows of the same
 * age would collide on `_id`. */
function agedObjectId(seconds: number): ObjectId {
  const stamp = Math.floor(seconds).toString(16).padStart(8, '0');
  return new ObjectId(stamp + (++idNonce).toString(16).padStart(16, '0'));
}

async function seedRow(database: Db, daysAgo: number, cursor: number): Promise<ObjectId> {
  const at = new Date(Date.now() - daysAgo * DAY_MS);
  const _id = agedObjectId(at.getTime() / 1000);
  await database.collection('asset_changes').insertOne({
    _id,
    cursor,
    asset_id: new ObjectId(),
    folder_id: new ObjectId(),
    kind: 'update',
    abs_path: `/lib/${cursor}.dng`,
    relative_path: `${cursor}.dng`,
    at,
  } as never);
  return _id;
}

async function survivingCursors(database: Db): Promise<number[]> {
  const rows = await database
    .collection<{ cursor: number }>('asset_changes')
    .find({}, { projection: { cursor: 1 } })
    .sort({ cursor: 1 })
    .toArray();
  return rows.map((r) => r.cursor);
}

describe('change-log-gc', () => {
  it('deletes only rows below the retention floor', async () => {
    if (!mongoReachable || !db) return;
    await saveChangeLogGcConfig({ retention_days: 30 });
    // Two comfortably outside the window, two comfortably inside it.
    await seedRow(db, 90, 1);
    await seedRow(db, 45, 2);
    await seedRow(db, 10, 3);
    await seedRow(db, 0, 4);

    const summary = await runChangeLogGcOnce({ pauseMs: 0 });

    expect(summary.skipped).toBe(false);
    expect(summary.deleted).toBe(2);
    expect(await survivingCursors(db)).toEqual([3, 4]);
  });

  it('reads the retention window from worker_config rather than a constant', async () => {
    if (!mongoReachable || !db) return;
    // 7 days, not the 30-day default: the 10-day-old row must now be pruned.
    await saveChangeLogGcConfig({ retention_days: 7 });
    await seedRow(db, 10, 1);
    await seedRow(db, 3, 2);

    const summary = await runChangeLogGcOnce({ pauseMs: 0 });

    expect(summary.retentionDays).toBe(7);
    expect(summary.deleted).toBe(1);
    expect(await survivingCursors(db)).toEqual([2]);

    // Widen it again and the same shaped row survives — proving the window is
    // read per pass, not captured at import.
    await saveChangeLogGcConfig({ retention_days: 3650 });
    await seedRow(db, 10, 3);
    const second = await runChangeLogGcOnce({ pauseMs: 0 });
    expect(second.retentionDays).toBe(3650);
    expect(second.deleted).toBe(0);
    expect(await survivingCursors(db)).toEqual([2, 3]);
  });

  it('does nothing while disabled in worker_config', async () => {
    if (!mongoReachable || !db) return;
    await saveChangeLogGcConfig({ enabled: false, retention_days: 1 });
    await seedRow(db, 90, 1);

    const summary = await runChangeLogGcOnce({ pauseMs: 0 });

    expect(summary.skipped).toBe(true);
    expect(summary.deleted).toBe(0);
    expect(await survivingCursors(db)).toEqual([1]);
  });

  it('batches the deletes and yields between them instead of starving the loop', async () => {
    if (!mongoReachable || !db) return;
    await saveChangeLogGcConfig({ retention_days: 30 });
    for (let i = 1; i <= 25; i++) await seedRow(db, 60 + i, i);

    // A timer scheduled alongside the sweep must get to run. With one
    // unbounded deleteMany (or no pause between batches) it would not fire
    // until the whole backlog was gone.
    let sweepDone = false;
    let tickedDuringSweep = false;
    const sweep = runChangeLogGcOnce({ batchSize: 5, pauseMs: 1 }).then((s) => {
      sweepDone = true;
      return s;
    });
    const probe = new Promise<void>((resolve) =>
      setTimeout(() => {
        tickedDuringSweep = !sweepDone;
        resolve();
      }, 2),
    );
    const summary = await sweep;
    await probe;

    expect(summary.deleted).toBe(25);
    expect(summary.batches).toBe(5);
    expect(tickedDuringSweep).toBe(true);
    expect(await survivingCursors(db)).toEqual([]);
  });

  it('stops mid-sweep when the handle is cancelled', async () => {
    if (!mongoReachable || !db) return;
    await saveChangeLogGcConfig({ retention_days: 30 });
    for (let i = 1; i <= 20; i++) await seedRow(db, 60 + i, i);

    let batchesSeen = 0;
    const summary = await runChangeLogGcOnce({
      batchSize: 5,
      pauseMs: 0,
      shouldStop: () => ++batchesSeen > 2,
    });

    expect(summary.deleted).toBe(10);
    expect((await survivingCursors(db)).length).toBe(10);
  });

  it('keeps the allocator cursor monotonic across a sweep', async () => {
    if (!mongoReachable || !db) return;
    await saveChangeLogGcConfig({ retention_days: 30 });
    // Burn real cursors so the allocator row exists with a known value.
    for (let i = 0; i < 5; i++) await allocateCursor();
    const before = await allocateCursor();
    await seedRow(db, 90, before - 3);
    await seedRow(db, 90, before - 1);

    await runChangeLogGcOnce({ pauseMs: 0 });

    // The allocator row is untouched: the next allocation is still before + 1.
    const after = await allocateCursor();
    expect(after).toBe(before + 1);
    const allocator = await db
      .collection<{ _id: string; seq?: number }>('server_state')
      .findOne({ _id: 'asset_changes_cursor' });
    expect(allocator?.seq).toBe(before + 1);
  });

  it('raises the retention floor to the highest pruned cursor, never rewinding it', async () => {
    if (!mongoReachable || !db) return;
    await saveChangeLogGcConfig({ retention_days: 30 });
    await seedRow(db, 90, 40);
    await seedRow(db, 60, 70);

    await runChangeLogGcOnce({ pauseMs: 0 });
    expect(await prunedThroughCursor()).toBe(70);

    // A later pass that prunes older/lower cursors must not lower the floor.
    await seedRow(db, 120, 5);
    await runChangeLogGcOnce({ pauseMs: 0 });
    expect(await prunedThroughCursor()).toBe(70);
  });

  it('records the pass summary where the API process can read it', async () => {
    if (!mongoReachable || !db) return;
    await saveChangeLogGcConfig({ retention_days: 30 });
    await seedRow(db, 90, 11);
    await seedRow(db, 1, 12);

    await runChangeLogGcOnce({ pauseMs: 0 });

    const config = await loadChangeLogGcConfig();
    expect(config.last_run?.deleted).toBe(1);
    expect(config.last_run?.pruned_through).toBe(11);
    expect(config.last_run?.remaining).toBe(1);
    expect(typeof config.last_run?.finished_at).toBe('string');
    expect(config.last_run?.error).toBeUndefined();
  });

  it('clamps an out-of-range retention window instead of storing it', async () => {
    if (!mongoReachable || !db) return;
    expect((await saveChangeLogGcConfig({ retention_days: 0 })).retention_days).toBe(1);
    expect((await saveChangeLogGcConfig({ retention_days: 99_999 })).retention_days).toBe(3650);
  });

  it('defaults to a 30-day window when nothing has been configured', async () => {
    if (!mongoReachable || !db) return;
    const config = await loadChangeLogGcConfig();
    expect(config.enabled).toBe(true);
    expect(config.retention_days).toBe(30);
    expect(config.last_run).toBeNull();
  });
});
