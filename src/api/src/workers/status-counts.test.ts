/**
 * Worker-side status counts (#3491): the cadence rules, the refresh loop, and
 * the persisted results the API reads instead of counting on the request path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { closeDb, getDb } from '../db/client.ts';
import { withTestDb } from '../db/test-db.test-helpers.ts';
import {
  BACKOFF_FACTOR,
  MIGRATION_COUNTS_MIN_INTERVAL_MS,
  STAGE_COUNTS_IDLE_INTERVAL_MS,
  STAGE_COUNTS_MAX_INTERVAL_MS,
  STAGE_COUNTS_MIN_INTERVAL_MS,
  computeStatusCounts,
  countMigration,
  dueRefreshes,
  nextDelayMs,
  runMigrationCountsPass,
  runStatusCountsPass,
  startStatusCountsRefresher,
  type RefreshClock,
} from './status-counts.ts';
import type { Migration } from './migration/types.ts';

withTestDb(`maple_test_status_counts_${process.pid}`);

let suiteDb: Db | null = null;
let dbReachable = true;
beforeAll(async () => {
  try {
    await closeDb();
    suiteDb = await getDb();
  } catch {
    dbReachable = false;
  }
});
beforeEach(async () => {
  if (!dbReachable) return;
  const db = await getDb();
  await db.collection('assets').deleteMany({});
  await db.collection('worker_status').deleteMany({});
  await db.collection('app_settings').deleteMany({ _id: 'migration' as never });
});
afterAll(async () => {
  if (suiteDb) await suiteDb.dropDatabase();
  await closeDb();
});

describe('nextDelayMs — back-off in proportion to the last pass', () => {
  it('rests BACKOFF_FACTOR × the last duration, clamped to [min, max]', () => {
    expect(nextDelayMs(0, 5_000, 120_000)).toBe(5_000);
    expect(nextDelayMs(1_000, 5_000, 120_000)).toBe(5_000);
    expect(nextDelayMs(10_000, 5_000, 120_000)).toBe(10_000 * BACKOFF_FACTOR);
    // A 90 s pass would earn 270 s — capped so counts never go stale beyond max.
    expect(nextDelayMs(90_000, 5_000, 120_000)).toBe(120_000);
  });
});

describe('dueRefreshes — demand-aware cadence', () => {
  const idle: RefreshClock = {
    bootAt: 0,
    lastStageRunAt: 0,
    lastStageDurationMs: 0,
    lastMigrationRunAt: 0,
    lastMigrationDurationMs: 0,
  };

  it('while watched: stage counts after the min interval, migrations after theirs', () => {
    const now = 1_000_000;
    const clock: RefreshClock = {
      bootAt: 0,
      lastStageRunAt: now - STAGE_COUNTS_MIN_INTERVAL_MS + 1,
      lastStageDurationMs: 0,
      lastMigrationRunAt: now - MIGRATION_COUNTS_MIN_INTERVAL_MS + 1,
      lastMigrationDurationMs: 0,
    };
    expect(dueRefreshes(now, now + 1, clock)).toEqual({ stage: false, migration: false });
    expect(dueRefreshes(now + 1, now + 2, clock)).toEqual({ stage: true, migration: true });
  });

  it('while watched: a slow pass pushes the next one out (never beyond the max)', () => {
    const now = 1_000_000;
    const clock: RefreshClock = {
      ...idle,
      lastStageRunAt: now - STAGE_COUNTS_MIN_INTERVAL_MS - 1,
      lastStageDurationMs: 30_000, // 30 s pass → 90 s rest
    };
    expect(dueRefreshes(now, now + 1, clock).stage).toBe(false);
    expect(
      dueRefreshes(now - STAGE_COUNTS_MIN_INTERVAL_MS - 1 + 90_000, now + 1e9, clock).stage,
    ).toBe(true);
    const glacial: RefreshClock = { ...clock, lastStageDurationMs: 10 * 60_000 };
    expect(
      dueRefreshes(glacial.lastStageRunAt + STAGE_COUNTS_MAX_INTERVAL_MS, now + 1e9, glacial).stage,
    ).toBe(true);
  });

  it('idle (demand lapsed): stage counts only every idle interval, migrations never', () => {
    const now = 10_000_000;
    const clock: RefreshClock = {
      ...idle,
      lastStageRunAt: now - STAGE_COUNTS_IDLE_INTERVAL_MS + 1,
    };
    // Demand deadline in the past → idle rules.
    expect(dueRefreshes(now, now - 1, clock)).toEqual({ stage: false, migration: false });
    expect(dueRefreshes(now + 1, now - 1, clock)).toEqual({ stage: true, migration: false });
    // Even with migrations long overdue by the watched rule, idle never runs them.
    expect(dueRefreshes(now + 1, 0, idle).migration).toBe(false);
  });

  it('a fresh worker: no idle pass until IDLE_INTERVAL after boot, but demand runs one at once', () => {
    const boot = 5_000_000;
    const fresh: RefreshClock = { ...idle, bootAt: boot };
    expect(dueRefreshes(boot + 1, 0, fresh).stage).toBe(false);
    expect(dueRefreshes(boot + STAGE_COUNTS_IDLE_INTERVAL_MS, 0, fresh).stage).toBe(true);
    expect(dueRefreshes(boot + 1, boot + 2, fresh)).toEqual({ stage: true, migration: true });
  });
});

describe('startStatusCountsRefresher — loop', () => {
  it('runs the stage pass when demand is poked, records its duration, and never overlaps', async () => {
    let now = 1_000_000;
    let stagePasses = 0;
    let migrationPasses = 0;
    let wantedUntil = 0;
    const h = startStatusCountsRefresher({
      pollMs: 60_000_000, // timer never fires in-test; we drive polls by hand
      now: () => now,
      readDemand: async () => wantedUntil,
      stagePass: async () => {
        stagePasses++;
        now += 7_000; // a 7 s pass
      },
      migrationPass: async () => {
        migrationPasses++;
      },
    });
    try {
      // Boot: nothing is due (the first idle pass is IDLE_INTERVAL after boot).
      await h._pollForTests();
      expect(stagePasses).toBe(0);
      expect(migrationPasses).toBe(0);

      // Someone opens the Workers page.
      wantedUntil = now + 30_000;
      await h._pollForTests();
      expect(stagePasses).toBe(1);
      expect(migrationPasses).toBe(1);

      // Immediately again: the 7 s pass earned a 21 s rest — not due yet.
      await h._pollForTests();
      expect(stagePasses).toBe(1);
      now += 21_000;
      wantedUntil = now + 30_000;
      await h._pollForTests();
      expect(stagePasses).toBe(2);
      // Migrations: 30 s minimum between passes, so still one.
      expect(migrationPasses).toBe(1);
    } finally {
      h.stop();
    }
  });

  it('stop() prevents any further pass', async () => {
    let passes = 0;
    let now = 0;
    const h = startStatusCountsRefresher({
      pollMs: 60_000_000,
      now: () => now,
      readDemand: async () => now + 1,
      stagePass: async () => {
        passes++;
      },
      migrationPass: async () => {},
    });
    h.stop();
    now = STAGE_COUNTS_IDLE_INTERVAL_MS + 1;
    await h._pollForTests();
    expect(passes).toBe(0);
  });

  it('a throwing pass is logged and does not break the loop', async () => {
    let now = 0;
    let calls = 0;
    const h = startStatusCountsRefresher({
      pollMs: 60_000_000,
      now: () => now,
      readDemand: async () => now + 1,
      stagePass: async () => {
        calls++;
        throw new Error('boom');
      },
      migrationPass: async () => {},
    });
    try {
      now = STAGE_COUNTS_IDLE_INTERVAL_MS + 1;
      await h._pollForTests();
      expect(calls).toBe(1);
      now += STAGE_COUNTS_MIN_INTERVAL_MS + 1;
      await h._pollForTests();
      expect(calls).toBe(2);
    } finally {
      h.stop();
    }
  });
});

function asset(extra: Record<string, unknown>) {
  return {
    fileinfo: [{ path: '', filename: 'x.jpg', library_id: new ObjectId(), deleted_at: null }],
    maple_id: new ObjectId().toHexString() + new ObjectId().toHexString(),
    size: 1,
    mtime: 0,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: '2026-01-01T00:00:00Z',
    stages: {},
    ...extra,
  };
}

describe('computeStatusCounts + runStatusCountsPass', () => {
  it('counts pending / ready / dead per stage plus the collection-level totals, and persists them', async () => {
    if (!dbReachable) return;
    const db = await getDb();
    await db.collection('assets').insertMany([
      asset({ stages: { exif: { version: 1 } } }), // pending + ready
      asset({ stages: {} }), // pending + ready (no stages.exif)
      asset({ stages: { exif: { version: 2 } } }), // done
      asset({ stages: { exif: { version: 1, dead: true } } }), // dead only
      asset({ stages: {}, damaged: { since: '2026-01-01T00:00:00Z' } }), // pending, damaged, not ready
      asset({
        stages: { exif: { version: 2 } },
        hidden: true,
        hidden_ack: false,
        hidden_reason: 'nudity',
      }),
    ]);
    const statuses = {
      exif: {
        status: 'running' as const,
        inFlight: 0,
        throughput: 0,
        targetVersion: 2,
        dependsOn: [],
        lastError: null,
      },
    };
    const counts = await computeStatusCounts(['exif', 'missing-reaper', 'deduplicate'], statuses);
    expect(counts.pending['exif']).toBe(3);
    expect(counts.ready['exif']).toBe(2);
    expect(counts.dead['exif']).toBe(1);
    expect(counts.pending['missing-reaper']).toBe(0);
    expect(counts.pending['deduplicate']).toBe(0);
    expect(counts.damaged).toBe(1);
    expect(counts.newly_hidden).toBe(1);
    expect(counts.computed_at).toBeGreaterThan(0);
    expect(counts.duration_ms).toBeGreaterThanOrEqual(0);

    // The pass persists a snapshot the API can read with one findOne.
    const persisted = await runStatusCountsPass();
    const doc = await db.collection('worker_status').findOne({ _id: 'singleton' as never });
    expect((doc as { counts?: unknown } | null)?.counts).toEqual(persisted);
    expect(persisted.damaged).toBe(1);
  });
});

describe('countMigration + runMigrationCountsPass', () => {
  const fake = (overrides: Partial<Migration>): Migration => ({
    id: 'fake',
    title: 'Fake',
    description: '',
    countRemaining: async () => 5,
    runBatch: async () => ({ processed: 0, errors: 0 }),
    ...overrides,
  });

  it('records remaining (+ failedPermanently when the migration tracks one)', async () => {
    const at = '2026-09-11T00:00:00.000Z';
    expect(await countMigration(fake({}), at)).toEqual({ remaining: 5, remaining_at: at });
    expect(await countMigration(fake({ countFailedPermanently: async () => 2 }), at)).toEqual({
      remaining: 5,
      remaining_at: at,
      failed_permanently: 2,
    });
  });

  it('a failing count leaves the previous value alone instead of writing a fake 0', async () => {
    const at = '2026-09-11T00:00:00.000Z';
    expect(
      await countMigration(
        fake({
          countRemaining: async () => {
            throw new Error('scan failed');
          },
        }),
        at,
      ),
    ).toEqual({});
  });

  it("persists every migration's counts on the migration state doc", async () => {
    if (!dbReachable) return;
    await runMigrationCountsPass([
      fake({ id: 'fake-a' }),
      fake({ id: 'fake-b', countRemaining: async () => 0 }),
    ]);
    const { loadAllMigrationStates } = await import('./migration-config.repo.ts');
    const states = await loadAllMigrationStates();
    expect(states['fake-a']?.remaining).toBe(5);
    expect(states['fake-b']?.remaining).toBe(0);
    expect(typeof states['fake-a']?.remaining_at).toBe('string');
  });
});

// computeStatusCounts's deduplicate count must exclude assets where the 2nd
// fileinfo entry is tombstoned (missing_since or deleted_at set), so the
// badge reflects what the worker can actually act on (and can reach 0).
describe('deduplicate count — computeStatusCounts (#1290)', () => {
  it('does NOT count an asset with 1 live + 1 missing_since sibling', async () => {
    if (!dbReachable) return;
    const db = await getDb();
    const libraryId = new (await import('mongodb')).ObjectId();
    // Asset: one live entry + one tombstoned via missing_since.
    // The coarse predicate `fileinfo.1 exists` would count this; the live-aware
    // predicate must NOT.
    await db.collection('assets').insertOne({
      fileinfo: [
        { path: 'live', filename: 'IMG.dng', library_id: libraryId },
        {
          path: 'gone',
          filename: 'IMG.dng',
          library_id: libraryId,
          missing_since: '2026-01-01T00:00:00Z',
        },
      ],
      maple_id: 'b'.repeat(32),
      size: 1,
      mtime: 0,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: '2026-06-01T00:00:00Z',
      deleted_at: null,
      stages: {},
      live_location_count: 1,
    } as never);

    const counts = await computeStatusCounts(['deduplicate'], {});
    const pending = counts.pending['deduplicate'] ?? 0;
    const ready = counts.ready['deduplicate'] ?? 0;
    expect(pending).toBe(0);
    expect(ready).toBe(0);
  });

  it('does NOT count an asset with 1 live + 1 deleted_at sibling', async () => {
    if (!dbReachable) return;
    const db = await getDb();
    const libraryId = new (await import('mongodb')).ObjectId();
    await db.collection('assets').insertOne({
      fileinfo: [
        { path: 'live', filename: 'IMG.dng', library_id: libraryId },
        {
          path: 'replaced',
          filename: 'IMG.dng',
          library_id: libraryId,
          deleted_at: '2026-01-01T00:00:00Z',
        },
      ],
      maple_id: 'c'.repeat(32),
      size: 1,
      mtime: 0,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: '2026-06-01T00:00:00Z',
      deleted_at: null,
      stages: {},
      live_location_count: 1,
    } as never);

    const counts = await computeStatusCounts(['deduplicate'], {});
    const pending = counts.pending['deduplicate'] ?? 0;
    const ready = counts.ready['deduplicate'] ?? 0;
    expect(pending).toBe(0);
    expect(ready).toBe(0);
  });

  it('DOES count an asset with >=2 live entries', async () => {
    if (!dbReachable) return;
    const db = await getDb();
    const libraryId = new (await import('mongodb')).ObjectId();
    await db.collection('assets').insertOne({
      fileinfo: [
        { path: 'a', filename: 'IMG.dng', library_id: libraryId },
        { path: 'b', filename: 'IMG.dng', library_id: libraryId },
      ],
      maple_id: 'd'.repeat(32),
      size: 1,
      mtime: 0,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: '2026-06-01T00:00:00Z',
      deleted_at: null,
      stages: {},
      live_location_count: 2,
    } as never);

    const counts = await computeStatusCounts(['deduplicate'], {});
    const pending = counts.pending['deduplicate'] ?? 0;
    const ready = counts.ready['deduplicate'] ?? 0;
    expect(pending).toBe(1);
    expect(ready).toBe(1);
  });
});
