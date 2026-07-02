/**
 * Migration worker tests.
 *
 *  - Registration / control surface: no DB needed (loadPaused tolerates an
 *    unreachable Mongo and defaults to running).
 *  - Enable-transition: pure logic, no DB.
 *  - End-to-end runBatch: seeds a backup-origin asset + a real temp file and
 *    drives one tick. Skips when MongoDB is unreachable (mirrors smoke.test).
 */
import { describe, it, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { stageRegistry } from './registry.ts';
import { startMigration, MIGRATION_WORKER_NAME, runMigrationTickOnce } from './migration.ts';
import { computeEnabledTransition, defaultMigrationState } from './migration-config.repo.ts';
import type { getDb as GetDbFn } from '../db/client.ts';

describe('startMigration — registration & control', () => {
  beforeEach(() => stageRegistry._resetForTests());

  it('registers under the migration name and reports running by default', () => {
    const handle = startMigration({ intervalMs: 60_000 });
    try {
      expect(stageRegistry.has(MIGRATION_WORKER_NAME)).toBe(true);
      const s = stageRegistry.statuses()[MIGRATION_WORKER_NAME];
      expect(s?.status).toBe('running');
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
    expect(stageRegistry.statuses()[MIGRATION_WORKER_NAME]?.status).toBe('running');
    handle.stop();
    expect(stageRegistry.has(MIGRATION_WORKER_NAME)).toBe(false);
  });
});

describe('computeEnabledTransition', () => {
  test('enabling arms a fresh run and clears progress', () => {
    const prev = { ...defaultMigrationState(), processed: 9, errors: 2, status: 'error' as const };
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

// ── Mongo-gated end-to-end ──────────────────────────────────────────────────

describe('migration end-to-end (restructure)', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = null;
    stageRegistry._resetForTests();
  });

  it('moves a backup-origin asset out of the MM-DD folder and repoints fileinfo', async () => {
    let getDb: typeof GetDbFn;
    try {
      ({ getDb } = await import('../db/client.ts'));
      await getDb();
    } catch {
      console.log('MongoDB unreachable — skipping migration end-to-end');
      return;
    }
    const { ObjectId } = await import('mongodb');
    const { setLibraryRootsForTests } = await import('../indexer/libraries.cache.ts');
    const { setMigrationEnabled, resetMigrationState } = await import('./migration-config.repo.ts');

    const db = await getDb();
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-e2e-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    // Real file in the OLD layout + a sidecar.
    const oldRel = '2024/Tokyo/03-15';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'IMG_E2E.HEIC'), 'pixels');
    await fs.writeFile(path.join(dir, oldRel, 'IMG_E2E.xmp'), 'edits');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'e2e-maple-id',
      fileinfo: [{ path: oldRel, filename: 'IMG_E2E.HEIC', library_id: libId, deleted_at: null }],
      phasset_links: [{ device_id: 'dev', phasset_local_id: 'ph', first_seen: new Date() }],
      size: 6,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      stages: { thumb: { version: 1 }, preview: { version: 1 } },
    } as never);

    try {
      await resetMigrationState('refile-backups');
      await setMigrationEnabled('refile-backups', true, new Date().toISOString());
      await runMigrationTickOnce(50, new Date().toISOString());

      const doc = (await assets.findOne({ _id })) as {
        fileinfo?: { path: string; filename: string }[];
        stages?: Record<string, { version: number }>;
      } | null;
      expect(doc?.fileinfo?.[0].path).toBe('2024/Tokyo');
      expect(doc?.fileinfo?.[0].filename).toBe('IMG_E2E.HEIC');
      // Cache stage versions reset so workers regenerate at the new path.
      expect(doc?.stages?.thumb.version).toBe(0);
      expect(doc?.stages?.preview.version).toBe(0);

      // File + sidecar moved; old day-folder reclaimed.
      expect(await fs.readFile(path.join(dir, '2024/Tokyo/IMG_E2E.HEIC'), 'utf8')).toBe('pixels');
      expect(await fs.readFile(path.join(dir, '2024/Tokyo/IMG_E2E.xmp'), 'utf8')).toBe('edits');
      await expect(fs.stat(path.join(dir, oldRel))).rejects.toThrow();
    } finally {
      await assets.deleteOne({ _id });
      await resetMigrationState('refile-backups');
      setLibraryRootsForTests(null);
    }
  });

  it('collision: two same-name assets from different day-folders → one renamed, both fileinfo correct, no loss', async () => {
    let getDb: typeof GetDbFn;
    try {
      ({ getDb } = await import('../db/client.ts'));
      await getDb();
    } catch {
      console.log('MongoDB unreachable — skipping migration collision e2e');
      return;
    }
    const { ObjectId } = await import('mongodb');
    const { setLibraryRootsForTests } = await import('../indexer/libraries.cache.ts');
    const { setMigrationEnabled, resetMigrationState } = await import('./migration-config.repo.ts');

    const db = await getDb();
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-collide-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    // Same filename, DIFFERENT content, different MM-DD → both collapse to 2024/Tokyo.
    const idA = new ObjectId();
    const idB = new ObjectId();
    await fs.mkdir(path.join(dir, '2024/Tokyo/03-15'), { recursive: true });
    await fs.mkdir(path.join(dir, '2024/Tokyo/03-16'), { recursive: true });
    await fs.writeFile(path.join(dir, '2024/Tokyo/03-15/DUP.HEIC'), 'content-A');
    await fs.writeFile(path.join(dir, '2024/Tokyo/03-16/DUP.HEIC'), 'content-B');
    const mk = (id: InstanceType<typeof ObjectId>, rel: string) => ({
      _id: id,
      maple_id: `mid-${id.toHexString()}`,
      fileinfo: [{ path: rel, filename: 'DUP.HEIC', library_id: libId, deleted_at: null }],
      phasset_links: [
        { device_id: 'd', phasset_local_id: id.toHexString(), first_seen: new Date() },
      ],
      size: 9,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
    });
    await assets.insertOne(mk(idA, '2024/Tokyo/03-15') as never);
    await assets.insertOne(mk(idB, '2024/Tokyo/03-16') as never);

    try {
      await resetMigrationState('refile-backups');
      await setMigrationEnabled('refile-backups', true, new Date().toISOString());
      await runMigrationTickOnce(50, new Date().toISOString());

      const docs = (await assets.find({ _id: { $in: [idA, idB] } }).toArray()) as {
        fileinfo: { path: string; filename: string }[];
      }[];
      // Both now live under 2024/Tokyo; filenames are DUP.HEIC and DUP.1.HEIC.
      for (const d of docs) expect(d.fileinfo[0].path).toBe('2024/Tokyo');
      const names = docs.map((d) => d.fileinfo[0].filename).sort();
      expect(names).toEqual(['DUP.1.HEIC', 'DUP.HEIC']);

      // Both files present at their recorded paths; neither content lost.
      const contents = await Promise.all(
        docs.map((d) => fs.readFile(path.join(dir!, '2024/Tokyo', d.fileinfo[0].filename), 'utf8')),
      );
      expect(contents.sort()).toEqual(['content-A', 'content-B']);
      // No overwrite: distinct bytes preserved at distinct names.
    } finally {
      await assets.deleteMany({ _id: { $in: [idA, idB] } });
      await resetMigrationState('refile-backups');
      setLibraryRootsForTests(null);
    }
  });
});

describe('pruneUnknownMigrationStates', () => {
  it('drops persisted state for ids no longer in the registry, keeps the rest', async () => {
    let getDb: typeof GetDbFn;
    try {
      ({ getDb } = await import('../db/client.ts'));
      await getDb();
    } catch {
      console.log('MongoDB unreachable — skipping prune e2e');
      return;
    }
    const { pruneUnknownMigrationStates, loadAllMigrationStates } =
      await import('./migration-config.repo.ts');
    const { MIGRATIONS } = await import('./migration/index.ts');
    const db = await getDb();
    const settings = db.collection<{ _id: string; migrations?: Record<string, unknown> }>(
      'app_settings',
    );
    const DEAD_A = 'zz-test-dead-a';
    const DEAD_B = 'zz-test-dead-b';
    const KEEP = 'zz-test-keep';

    // Seed one sentinel that survives + two orphans that should be pruned.
    await settings.updateOne(
      { _id: 'migration' },
      {
        $set: {
          [`migrations.${KEEP}`]: { enabled: true, status: 'running' },
          [`migrations.${DEAD_A}`]: { enabled: true, status: 'running' },
          [`migrations.${DEAD_B}`]: { enabled: false, status: 'done' },
        },
      },
      { upsert: true },
    );

    try {
      // Known set = the live registry PLUS our sentinel, so real migration state
      // is never touched even if this runs against a populated DB.
      const known = [...MIGRATIONS.map((m) => m.id), KEEP];
      const pruned = await pruneUnknownMigrationStates(known);
      expect(pruned).toContain(DEAD_A);
      expect(pruned).toContain(DEAD_B);

      const all = await loadAllMigrationStates();
      expect(all[DEAD_A]).toBeUndefined();
      expect(all[DEAD_B]).toBeUndefined();
      expect(all[KEEP]).toBeDefined();
    } finally {
      await settings.updateOne(
        { _id: 'migration' },
        {
          $unset: {
            [`migrations.${KEEP}`]: '',
            [`migrations.${DEAD_A}`]: '',
            [`migrations.${DEAD_B}`]: '',
          },
        },
      );
    }
  });
});
