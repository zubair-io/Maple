/**
 * The task list's schedule rules: how often each task runs, and exactly when
 * its schedule is paused, read from a real database.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createLiveTestDatabase, run } from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { clearMirrorRoots, setMirrorRoots } from '../../fs/mirror-registry.ts';
import { saveChangeLogGcConfig } from '../change-log-gc-config.repo.ts';
import { saveDerivativeAuditConfig } from '../derivative-audit/config.repo.ts';
import { DEDUPLICATE_NAME } from '../dedupe.ts';
import { saveGeneratedSearchConfig } from '../generated-search/config.repo.ts';
import { MIGRATION_WORKER_NAME } from '../migration.ts';
import { MIGRATIONS } from '../migration/index.ts';
import { setMigrationEnabled } from '../migration-config.repo.ts';
import { MISSING_REAPER_NAME } from '../missing-reaper.ts';
import { MAINTENANCE_TASKS, type DesiredSchedule } from './tasks.ts';

const MINUTE = 60_000;

afterEach(() => clearMirrorRoots());

const task = (id: string) => {
  const found = MAINTENANCE_TASKS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no task ${id}`);
  return found;
};

const desired = (id: string): Promise<DesiredSchedule> => task(id).desired();

const pauseWorker = (db: Database, name: string, paused: boolean) =>
  run(db, `INSERT INTO worker_config (name, paused) VALUES (?, ?)`, name, paused ? 1 : 0);

describe('the task list', () => {
  test('names every task once', () => {
    const ids = MAINTENANCE_TASKS.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('keeps the intervals of the timers it replaced', async () => {
    using _live = await createLiveTestDatabase();
    const intervals = Object.fromEntries(
      await Promise.all(MAINTENANCE_TASKS.map(async (t) => [t.id, (await t.desired()).everyMs])),
    );
    expect(intervals).toEqual({
      'trash-gc': 24 * 60 * MINUTE,
      'trash-cleanup': MINUTE,
      'change-log-gc': 24 * 60 * MINUTE,
      'missing-reaper': MINUTE,
      deduplicate: 5 * MINUTE,
      migration: 5_000,
      'mirror-scan': 60 * MINUTE,
      'mirror-copy': 30_000,
      'derivative-audit': 6 * 60 * MINUTE,
      'generated-search': 15 * MINUTE,
      'cloud-backup': MINUTE,
    });
  });
});

describe('schedules that never pause', () => {
  test('the reaper keeps running while paused, since recovery still happens', async () => {
    using live = await createLiveTestDatabase();
    pauseWorker(live.db, MISSING_REAPER_NAME, true);
    expect((await desired('missing-reaper')).paused).toBe(false);
  });

  test('generated-search keeps running while paused, since retention still prunes', async () => {
    using _live = await createLiveTestDatabase();
    await saveGeneratedSearchConfig({ paused: true });
    expect((await desired('generated-search')).paused).toBe(false);
  });

  test('trash, cleanup and cloud-backup maintenance have no switch', async () => {
    using _live = await createLiveTestDatabase();
    for (const id of ['trash-gc', 'trash-cleanup', 'cloud-backup'])
      expect((await desired(id)).paused).toBe(false);
  });
});

describe('schedules paused by configuration', () => {
  test('change-log-gc pauses when it is disabled', async () => {
    using _live = await createLiveTestDatabase();
    expect((await desired('change-log-gc')).paused).toBe(false);
    await saveChangeLogGcConfig({ enabled: false });
    expect((await desired('change-log-gc')).paused).toBe(true);
  });

  test('deduplicate is paused until an operator resumes it', async () => {
    using live = await createLiveTestDatabase();
    expect((await desired('deduplicate')).paused).toBe(true);
    pauseWorker(live.db, DEDUPLICATE_NAME, false);
    expect((await desired('deduplicate')).paused).toBe(false);
  });

  test('migration pauses while no enabled migration is left, or the worker is paused', async () => {
    using live = await createLiveTestDatabase();
    expect((await desired('migration')).paused).toBe(true);
    await setMigrationEnabled(MIGRATIONS[0]!.id, true, new Date().toISOString());
    expect((await desired('migration')).paused).toBe(false);
    pauseWorker(live.db, MIGRATION_WORKER_NAME, true);
    expect((await desired('migration')).paused).toBe(true);
  });

  test('both mirror tasks pause while no library has a mirror', async () => {
    using _live = await createLiveTestDatabase();
    expect((await desired('mirror-scan')).paused).toBe(true);
    expect((await desired('mirror-copy')).paused).toBe(true);
    setMirrorRoots({ '/library': ['/mirror'] });
    expect((await desired('mirror-scan')).paused).toBe(false);
    expect((await desired('mirror-copy')).paused).toBe(false);
  });

  test('derivative-audit follows its enabled flag and configured interval', async () => {
    using _live = await createLiveTestDatabase();
    await saveDerivativeAuditConfig({ enabled: false, interval_ms: 2 * 60 * MINUTE });
    expect(await desired('derivative-audit')).toEqual({ everyMs: 2 * 60 * MINUTE, paused: true });
  });
});

describe('passes that find nothing to do', () => {
  test('a mirror-copy run that lands after mirroring was switched off claims nothing', async () => {
    using live = await createLiveTestDatabase();
    run(
      live.db,
      `INSERT INTO mirror_queue (primary_path, mirror_path, reason, enqueued_at)
       VALUES ('/library/a.dng', '/mirror/a.dng', 'scan-missing', ?)`,
      Date.now(),
    );
    await task('mirror-copy').run(new AbortController().signal, {});
    expect(live.db.query(`SELECT claimed_at, attempts FROM mirror_queue`).get()).toEqual({
      claimed_at: null,
      attempts: 0,
    });
  });

  test('a deduplicate run that lands after a pause moves nothing', async () => {
    using live = await createLiveTestDatabase();
    pauseWorker(live.db, DEDUPLICATE_NAME, true);
    await task('deduplicate').run(new AbortController().signal, {});
    expect(live.db.query(`SELECT COUNT(*) AS n FROM worker_config`).get()).toEqual({ n: 1 });
  });
});
