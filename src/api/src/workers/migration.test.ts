/**
 * Migration worker tests.
 *
 *  - Registration / control surface: the worker's registry entry and its
 *    pause/resume round trip.
 *  - Enable-transition: pure logic, no database.
 *  - End-to-end `runMigrationTickOnce`: seeds a backup-origin asset and a real
 *    temp file, drives one tick, and checks both the on-disk move and the
 *    worker's own persisted progress.
 *
 * Everything here runs against a real SQLite database installed as the
 * process-wide handle: per-migration state lives in the `migration` row of
 * `app_settings`, reached through `readAppSettings` / `patchAppSettings`, and
 * the refile migration reads and writes `assets` / `asset_locations` through the
 * repositories under `db/sqlite/repos/`. Pruning of unregistered migration ids
 * is a property of that settings row and is covered by
 * `migration-config.repo.test.ts`, so it is not repeated here.
 */
import { describe, it, test, expect, afterEach, beforeEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { stageRegistry } from './registry.ts';
import { startMigration, MIGRATION_WORKER_NAME, runMigrationTickOnce } from './migration.ts';
import {
  computeEnabledTransition,
  defaultMigrationState,
  loadMigrationState,
  resetMigrationState,
  setMigrationEnabled,
} from './migration-config.repo.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { setLibraryRootsForTests } from '../indexer/libraries.cache.ts';

let live: LiveTestDatabase;

beforeEach(async () => {
  live = await createLiveTestDatabase();
});

afterEach(() => {
  stageRegistry._resetForTests();
  live.close();
});

describe('startMigration — registration & control', () => {
  it('registers under the migration name and reports idle by default', () => {
    const handle = startMigration({ intervalMs: 60_000 });
    try {
      expect(stageRegistry.has(MIGRATION_WORKER_NAME)).toBe(true);
      const s = stageRegistry.statuses()[MIGRATION_WORKER_NAME];
      expect(s?.status).toBe('idle');
      expect(s?.dependsOn).toEqual([]); // not a claim stage
    } finally {
      handle.stop();
    }
  });

  it('pause / resume flip the reported status and stop() unregisters', async () => {
    const handle = startMigration({ intervalMs: 60_000 });
    await handle.ready;
    await stageRegistry.pause(MIGRATION_WORKER_NAME);
    expect(stageRegistry.statuses()[MIGRATION_WORKER_NAME]?.status).toBe('paused');
    await stageRegistry.resume(MIGRATION_WORKER_NAME);
    expect(stageRegistry.statuses()[MIGRATION_WORKER_NAME]?.status).toBe('idle');
    handle.stop();
    expect(stageRegistry.has(MIGRATION_WORKER_NAME)).toBe(false);
  });
});

describe('computeEnabledTransition', () => {
  test('enabling arms a fresh run and clears progress', () => {
    const prev = {
      ...defaultMigrationState(),
      processed: 9,
      errors: 2,
      status: 'error' as const,
    };
    const next = computeEnabledTransition(prev, true, '2026-05-31T00:00:00Z');
    expect(next.enabled).toBe(true);
    expect(next.status).toBe('running');
    expect(next.processed).toBe(0);
    expect(next.errors).toBe(0);
    expect(next.started_at).toBe('2026-05-31T00:00:00Z');
    expect(next.finished_at).toBeNull();
  });

  test('disabling keeps progress and idles (unless already done)', () => {
    const running = {
      ...defaultMigrationState(),
      enabled: true,
      status: 'running' as const,
      processed: 5,
    };
    const off = computeEnabledTransition(running, false, '2026-05-31T00:00:00Z');
    expect(off.enabled).toBe(false);
    expect(off.status).toBe('idle');
    expect(off.processed).toBe(5); // progress preserved

    const done = { ...running, status: 'done' as const };
    expect(computeEnabledTransition(done, false, 'x').status).toBe('done');
  });
});

// ── End-to-end ──────────────────────────────────────────────────────────────

/**
 * A backup-origin asset with one live location, which is what
 * `REFILE_BACKUP_SCOPE` selects on: at least one PHAsset link, at least one
 * location carrying neither tombstone.
 */
function seedBackupAsset(
  db: Database,
  args: { libraryId: string; relDir: string; filename: string; stages?: readonly string[] },
): string {
  const assetId = insertAsset(db);
  insertLocation(db, {
    assetId,
    libraryId: args.libraryId,
    path: args.relDir,
    filename: args.filename,
  });
  run(
    db,
    `INSERT INTO asset_phasset_links (asset_id, device_id, phasset_local_id, first_seen)
     VALUES (?, ?, ?, ?)`,
    assetId,
    'dev',
    assetId,
    new Date().toISOString(),
  );
  for (const stage of args.stages ?? []) {
    run(db, `INSERT INTO stage_state (asset_id, stage, version) VALUES (?, ?, 1)`, assetId, stage);
  }
  return assetId;
}

/** The live location an asset now claims, as `<path>/<filename>`. */
function locationOf(db: Database, assetId: string): string {
  const row = db
    .query(
      `SELECT path, filename FROM asset_locations
        WHERE asset_id = ? AND deleted_at IS NULL AND missing_since IS NULL`,
    )
    .get(assetId) as { path: string; filename: string } | null;
  if (row === null) throw new Error(`asset ${assetId} has no live location`);
  return `${row.path}/${row.filename}`;
}

function stageVersion(db: Database, assetId: string, stage: string): number {
  const row = db
    .query(`SELECT version FROM stage_state WHERE asset_id = ? AND stage = ?`)
    .get(assetId, stage) as { version: number } | null;
  return row?.version ?? -1;
}

describe('migration end-to-end (refile-backups)', () => {
  let dir: string;
  let libraryId: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-e2e-'));
    libraryId = insertFolder(live.db, { path: dir });
    setLibraryRootsForTests(new Map([[libraryId, dir]]));
  });

  afterEach(async () => {
    setLibraryRootsForTests(null);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('moves a backup-origin asset out of the MM-DD folder and repoints its location', async () => {
    const oldRel = '2024/Tokyo/03-15';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'IMG_E2E.HEIC'), 'pixels');
    await fs.writeFile(path.join(dir, oldRel, 'IMG_E2E.xmp'), 'edits');

    const assetId = seedBackupAsset(live.db, {
      libraryId,
      relDir: oldRel,
      filename: 'IMG_E2E.HEIC',
      stages: ['thumb', 'preview'],
    });

    await resetMigrationState('refile-backups');
    await setMigrationEnabled('refile-backups', true, new Date().toISOString());
    await runMigrationTickOnce(50, new Date().toISOString());

    expect(locationOf(live.db, assetId)).toBe('2024/Misc/IMG_E2E.HEIC');
    // The path-keyed caches were dropped with the move, so their stages are
    // re-armed and the workers regenerate at the new path.
    expect(stageVersion(live.db, assetId, 'thumb')).toBe(0);
    expect(stageVersion(live.db, assetId, 'preview')).toBe(0);

    // File + sidecar moved; old day-folder reclaimed.
    expect(await fs.readFile(path.join(dir, '2024/Misc/IMG_E2E.HEIC'), 'utf8')).toBe('pixels');
    expect(await fs.readFile(path.join(dir, '2024/Misc/IMG_E2E.xmp'), 'utf8')).toBe('edits');
    await expect(fs.stat(path.join(dir, oldRel))).rejects.toThrow();

    // The worker persists `remaining` as it goes (#3491) — the Workers page
    // reads that instead of running countRemaining() on every load. One
    // candidate, moved in this batch → remaining 0, migration done.
    const state = await loadMigrationState('refile-backups');
    expect(state.status).toBe('done');
    expect(state.remaining).toBe(0);
    expect(typeof state.remaining_at).toBe('string');
  });

  it('collision: two same-name assets from different day-folders → one renamed, both correct, no loss', async () => {
    // Same filename, DIFFERENT content, different MM-DD → both collapse to
    // 2024/Misc, so one of them has to be renamed rather than overwritten.
    await fs.mkdir(path.join(dir, '2024/Tokyo/03-15'), { recursive: true });
    await fs.mkdir(path.join(dir, '2024/Tokyo/03-16'), { recursive: true });
    await fs.writeFile(path.join(dir, '2024/Tokyo/03-15/DUP.HEIC'), 'content-A');
    await fs.writeFile(path.join(dir, '2024/Tokyo/03-16/DUP.HEIC'), 'content-B');

    const idA = seedBackupAsset(live.db, {
      libraryId,
      relDir: '2024/Tokyo/03-15',
      filename: 'DUP.HEIC',
    });
    const idB = seedBackupAsset(live.db, {
      libraryId,
      relDir: '2024/Tokyo/03-16',
      filename: 'DUP.HEIC',
    });

    await resetMigrationState('refile-backups');
    await setMigrationEnabled('refile-backups', true, new Date().toISOString());
    await runMigrationTickOnce(50, new Date().toISOString());

    const located = [locationOf(live.db, idA), locationOf(live.db, idB)].sort();
    expect(located).toEqual(['2024/Misc/DUP.1.HEIC', '2024/Misc/DUP.HEIC']);

    // Both files present at their recorded paths; neither content lost.
    const contents = await Promise.all(
      located.map((rel) => fs.readFile(path.join(dir, rel), 'utf8')),
    );
    expect(contents.sort()).toEqual(['content-A', 'content-B']);
  });
});
