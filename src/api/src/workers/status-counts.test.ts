/**
 * Worker-side status counts (#3491): the cadence rules, the refresh loop, and
 * the persisted results the API reads instead of counting on the request path.
 *
 * The counting itself is the repositories' — `countStageBacklog` in
 * `stage-state.repo.ts` and the four badge counts in `worker-admin.repo.ts`,
 * each with its own suite. What is asserted here is the shape this module puts
 * around them: which workers get a backlog, which get an asset-level queue
 * instead, and that a pass writes one snapshot the status route can read whole.
 */
import { describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { readWorkerStatus } from '../db/repos/worker-status.repo.ts';
import {
  BACKOFF_FACTOR,
  MIGRATION_COUNTS_MIN_INTERVAL_MS,
  STAGE_COUNTS_IDLE_INTERVAL_MS,
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
    // A 10 s pass earns a 30 s rest.
    const clock: RefreshClock = {
      bootAt: 0,
      lastStageRunAt: now - 29_000,
      lastStageDurationMs: 10_000,
      lastMigrationRunAt: now,
      lastMigrationDurationMs: 0,
    };
    expect(dueRefreshes(now, now + 1, clock).stage).toBe(false);
    expect(dueRefreshes(now + 1_001, now + 1_002, clock).stage).toBe(true);
  });

  it('idle (demand lapsed): stage counts only every idle interval, migrations never', () => {
    const now = STAGE_COUNTS_IDLE_INTERVAL_MS + 1;
    expect(dueRefreshes(now, 0, idle)).toEqual({ stage: true, migration: false });
    expect(
      dueRefreshes(now, 0, { ...idle, lastStageRunAt: now - STAGE_COUNTS_IDLE_INTERVAL_MS + 1 }),
    ).toEqual({ stage: false, migration: false });
  });

  it('a fresh worker: no idle pass until IDLE_INTERVAL after boot, but demand runs one at once', () => {
    const bootAt = 1_000_000;
    const clock: RefreshClock = { ...idle, bootAt };
    expect(dueRefreshes(bootAt + 1_000, 0, clock).stage).toBe(false);
    expect(dueRefreshes(bootAt + STAGE_COUNTS_IDLE_INTERVAL_MS, 0, clock).stage).toBe(true);
    // Demand ignores bootAt — someone is looking now.
    expect(dueRefreshes(bootAt + 1_000, bootAt + 2_000, clock).stage).toBe(true);
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

interface SeedAssetOptions {
  libraryId: string;
  stage?: { name: string; version?: number; dead?: number };
  locations?: number;
  missingLocations?: number;
  deletedLocations?: number;
  damaged?: boolean;
  newlyHidden?: boolean;
}

const AT = '2026-01-01T00:00:00Z';

/** The three kinds of location a fixture can ask for, in the order they are
 * added: which option counts them, how many there are when it is absent, and
 * the columns that kind sets. A table rather than three near-identical loops,
 * because the only thing that differs between them is that last column. */
const LOCATION_KINDS = [
  { count: 'locations', fallback: 1, extra: {} },
  { count: 'missingLocations', fallback: 0, extra: { missingSince: AT } },
  { count: 'deletedLocations', fallback: 0, extra: { deletedAt: AT } },
] as const;

/** The whole-asset states a fixture can flip on after the insert. Each is a
 * fixed statement, so they are data too. */
const ASSET_STATES = {
  damaged: `UPDATE assets SET damaged_since = '${AT}' WHERE id = ?`,
  newlyHidden: `UPDATE assets SET hidden = 1, hidden_ack = 0, hidden_reason = 'nudity' WHERE id = ?`,
} as const;

/** One asset with `locations` live locations and a stage row at `version`. */
function seedAsset(db: Database, options: SeedAssetOptions): string {
  const assetId = insertAsset(db);
  seedLocations(db, assetId, options);
  seedStage(db, assetId, options.stage);
  seedStates(db, assetId, options);
  return assetId;
}

/** Every location the fixture asked for, live ones first. `(library_id, path,
 * filename)` is unique, so each location of an asset needs a distinct directory
 * — the same thing two copies of one file on disk would have. The ordinal runs
 * across all three kinds, not per kind. */
function seedLocations(db: Database, assetId: string, options: SeedAssetOptions): void {
  let ordinal = 0;
  for (const kind of LOCATION_KINDS) {
    const wanted = options[kind.count] ?? kind.fallback;
    for (let i = 0; i < wanted; i++) {
      insertLocation(db, {
        assetId,
        libraryId: options.libraryId,
        ordinal,
        path: `dir-${ordinal++}`,
        ...kind.extra,
      });
    }
  }
}

/** The one stage row, when the fixture wants this asset to have stage state. */
function seedStage(db: Database, assetId: string, stage: SeedAssetOptions['stage']): void {
  if (!stage) return;
  db.run(`INSERT INTO stage_state (asset_id, stage, version, dead) VALUES (?, ?, ?, ?)`, [
    assetId,
    stage.name,
    stage.version ?? 0,
    stage.dead ?? 0,
  ]);
}

/** The asset-level states — damaged, newly hidden — the fixture switched on. */
function seedStates(db: Database, assetId: string, options: SeedAssetOptions): void {
  for (const [state, sql] of Object.entries(ASSET_STATES)) {
    if (options[state as keyof typeof ASSET_STATES] === true) db.run(sql, [assetId]);
  }
}

const EXIF_STATUS = {
  exif: {
    status: 'running' as const,
    inFlight: 0,
    throughput: 0,
    targetVersion: 2,
    dependsOn: [],
    lastError: null,
  },
};

describe('computeStatusCounts + runStatusCountsPass', () => {
  it('counts pending / ready / dead per stage plus the badge totals, and persists them', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = insertFolder(live.db);
    seedAsset(live.db, { libraryId, stage: { name: 'exif', version: 1 } }); // pending + ready
    seedAsset(live.db, { libraryId, stage: { name: 'exif', version: 0 } }); // pending + ready
    seedAsset(live.db, { libraryId, stage: { name: 'exif', version: 2 } }); // done
    seedAsset(live.db, { libraryId, stage: { name: 'exif', version: 1, dead: 1 } }); // dead only
    // Pending but not ready: a damaged asset is parked out of every claim.
    seedAsset(live.db, { libraryId, stage: { name: 'exif', version: 0 }, damaged: true });
    seedAsset(live.db, { libraryId, stage: { name: 'exif', version: 2 }, newlyHidden: true });

    const counts = await computeStatusCounts(
      ['exif', 'missing-reaper', 'deduplicate'],
      EXIF_STATUS,
    );

    expect(counts.pending['exif']).toBe(2);
    expect(counts.ready['exif']).toBe(2);
    expect(counts.dead['exif']).toBe(1);
    expect(counts.pending['missing-reaper']).toBe(0);
    expect(counts.pending['deduplicate']).toBe(0);
    expect(counts.damaged).toBe(1);
    expect(counts.newly_hidden).toBe(1);
    expect(counts.computed_at).toBeGreaterThan(0);
    expect(counts.duration_ms).toBeGreaterThanOrEqual(0);

    // The pass persists a snapshot the status route reads whole.
    const persisted = await runStatusCountsPass();
    expect((await readWorkerStatus())?.counts).toEqual(persisted);
    expect(persisted.damaged).toBe(1);
  });

  it('reports a stage parked behind an upstream dependency as pending but not ready', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = insertFolder(live.db);
    const assetId = seedAsset(live.db, { libraryId, stage: { name: 'thumb', version: 0 } });
    live.db.run(`INSERT INTO stage_state (asset_id, stage, version) VALUES (?, 'exif', 0)`, [
      assetId,
    ]);

    const counts = await computeStatusCounts(['thumb'], {
      thumb: {
        status: 'running',
        inFlight: 0,
        throughput: 0,
        targetVersion: 1,
        dependsOn: [{ name: 'exif', minVersion: 1 }],
        lastError: null,
      },
    });

    // The difference is what the Workers page renders as "blocked upstream" —
    // the one signal that tells an operator a backlog is parked, not stuck.
    expect(counts.pending['thumb']).toBe(1);
    expect(counts.ready['thumb']).toBe(0);
  });
});

/**
 * The deduplicate badge counts assets the worker can actually act on, so a
 * tombstoned second location must not keep it above zero (#1290).
 */
describe('the deduplicate and missing-reaper queues', () => {
  it('counts an asset with two live locations, and neither kind of tombstone', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = insertFolder(live.db);
    seedAsset(live.db, { libraryId, locations: 2 });
    seedAsset(live.db, { libraryId, locations: 1, missingLocations: 1 });
    seedAsset(live.db, { libraryId, locations: 1, deletedLocations: 1 });

    const counts = await computeStatusCounts(['deduplicate', 'missing-reaper'], {});

    expect(counts.pending['deduplicate']).toBe(1);
    expect(counts.ready['deduplicate']).toBe(1);
    // The reaper's queue is the other one: exactly the asset with a location
    // tagged missing.
    expect(counts.pending['missing-reaper']).toBe(1);
    expect(counts.ready['missing-reaper']).toBe(1);
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

  it("persists every migration's counts on the migration settings row", async () => {
    using _live = await createLiveTestDatabase();
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
