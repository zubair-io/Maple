/**
 * `worker_config` behaviour, exercised through the repository.
 *
 * The cases worth having are the ones where the stored row is not the shape
 * `WorkerConfig` declares: a partial written before the worker ever booted, a
 * resume that has to take the pause reason with it, and the discover row,
 * which shares the table but fills in a different set of columns.
 */

import { describe, expect, test } from 'bun:test';
import { createTestDatabase } from '../test-sqlite.test-helpers.ts';
import { testSqliteDb } from './assets.test-helpers.ts';
import {
  WorkerConfigRepo,
  listWorkerConfigs,
  loadDiscoverConfig,
  loadWorkerConfigSafe,
  patchDiscoverConfig,
  sanitizeWorkerConfig,
} from './worker-config.repo.ts';

const FULL = {
  concurrency: 4,
  maxAttempts: 3,
  paused: false,
  last_seen_target_version: 2,
};

describe('load', () => {
  test('returns null when the worker has no row yet', async () => {
    using handle = await createTestDatabase();
    expect(await new WorkerConfigRepo(testSqliteDb(handle.db)).load('thumb')).toBeNull();
  });

  test('round-trips a full config', async () => {
    using handle = await createTestDatabase();
    const repo = new WorkerConfigRepo(testSqliteDb(handle.db));
    await repo.upsert('thumb', { ...FULL, version: 'v0.2.1', ai_model: 'gemma4:12b' });
    expect(await repo.load('thumb')).toEqual({
      ...FULL,
      version: 'v0.2.1',
      ai_model: 'gemma4:12b',
    });
  });

  test('omits optional fields rather than reporting them as null', async () => {
    using handle = await createTestDatabase();
    const repo = new WorkerConfigRepo(testSqliteDb(handle.db));
    await repo.upsert('thumb', FULL);
    const loaded = await repo.load('thumb');
    // The omission is on the wire: `/api/workers/status` renders these rows,
    // and a permanent `pause_reason: null` on every worker is not the same
    // response body.
    expect(Object.keys(loaded ?? {}).sort()).toEqual([
      'concurrency',
      'last_seen_target_version',
      'maxAttempts',
      'paused',
    ]);
  });

  test('a field no write has set reads as absent, not as a default', async () => {
    using handle = await createTestDatabase();
    const repo = new WorkerConfigRepo(testSqliteDb(handle.db));
    // What `registerPausableWorker` does on a worker that has never booted.
    await repo.patch('deduplicate', { paused: true });
    const loaded = await repo.load('deduplicate');
    expect(loaded?.paused).toBe(true);
    // `bootConfig` substitutes the stage's own default for each of these, and
    // it can only do that if it can tell "unset" from a number. A `paused`
    // defaulted to false would likewise read as an operator resume and
    // suppress a stage's `pausedOnFirstBoot`.
    expect(loaded?.concurrency).toBeUndefined();
    expect(loaded?.maxAttempts).toBeUndefined();
    expect(loaded?.last_seen_target_version).toBeUndefined();
  });
});

describe('upsert', () => {
  test('creates the row on first write', async () => {
    using handle = await createTestDatabase();
    const repo = new WorkerConfigRepo(testSqliteDb(handle.db));
    await repo.upsert('exif', FULL);
    expect((await repo.load('exif'))?.concurrency).toBe(4);
  });

  test('leaves fields the config does not carry alone', async () => {
    using handle = await createTestDatabase();
    const repo = new WorkerConfigRepo(testSqliteDb(handle.db));
    await repo.upsert('meili', { ...FULL, paused: true, pause_reason: 'no embedder' });
    await repo.upsert('meili', { ...FULL, paused: true, concurrency: 8 });
    const loaded = await repo.load('meili');
    expect(loaded?.concurrency).toBe(8);
    expect(loaded?.pause_reason).toBe('no embedder');
  });
});

describe('patch', () => {
  test('writes before first boot instead of silently no-opping', async () => {
    using handle = await createTestDatabase();
    const repo = new WorkerConfigRepo(testSqliteDb(handle.db));
    await repo.patch('missing-reaper', { paused: true });
    expect((await repo.load('missing-reaper'))?.paused).toBe(true);
  });

  test('touches only the fields it names', async () => {
    using handle = await createTestDatabase();
    const repo = new WorkerConfigRepo(testSqliteDb(handle.db));
    await repo.upsert('describe', FULL);
    await repo.patch('describe', { concurrency: 1 });
    expect(await repo.load('describe')).toEqual({ ...FULL, concurrency: 1 });
  });

  test('a resume clears the reason the pause came with', async () => {
    using handle = await createTestDatabase();
    const repo = new WorkerConfigRepo(testSqliteDb(handle.db));
    await repo.upsert('meili', FULL);
    await repo.patch('meili', { paused: true, pause_reason: 'embedder address rejected' });
    expect((await repo.load('meili'))?.pause_reason).toBe('embedder address rejected');

    await repo.patch('meili', { paused: false });
    const resumed = await repo.load('meili');
    expect(resumed?.paused).toBe(false);
    // Not merely null — the key is gone, which is what the status row renders.
    expect(Object.keys(resumed ?? {})).not.toContain('pause_reason');
  });

  test('a fresh self-pause writes a new reason', async () => {
    using handle = await createTestDatabase();
    const repo = new WorkerConfigRepo(testSqliteDb(handle.db));
    await repo.patch('meili', { paused: true, pause_reason: 'first' });
    await repo.patch('meili', { paused: false });
    await repo.patch('meili', { paused: true, pause_reason: 'second' });
    expect((await repo.load('meili'))?.pause_reason).toBe('second');
  });

  test('a patch that names nothing neither inserts nor throws', async () => {
    using handle = await createTestDatabase();
    const repo = new WorkerConfigRepo(testSqliteDb(handle.db));
    await repo.patch('thumb', {});
    expect(await repo.load('thumb')).toBeNull();
  });

  test('a key that is only a property of Object is not a column', async () => {
    using handle = await createTestDatabase();
    const repo = new WorkerConfigRepo(testSqliteDb(handle.db));
    // What `Object.entries` over a JSON body can hand the column lookup. An
    // object-literal lookup answers these from its prototype with something
    // truthy and non-column-shaped, which then lands in the statement's column
    // list. The cast is the point of the test: the route validates its body, so
    // the type never permits this and only the runtime can.
    await repo.patch('thumb', {
      constructor: 1,
      toString: 2,
      hasOwnProperty: 3,
    } as unknown as Parameters<WorkerConfigRepo['patch']>[1]);
    expect(await repo.load('thumb')).toBeNull();
  });

  test('a recognised field still lands beside keys that are not columns', async () => {
    using handle = await createTestDatabase();
    const repo = new WorkerConfigRepo(testSqliteDb(handle.db));
    await repo.patch('thumb', {
      concurrency: 2,
      toString: 'nonsense',
    } as unknown as Parameters<WorkerConfigRepo['patch']>[1]);
    const loaded = await repo.load('thumb');
    expect(loaded?.concurrency).toBe(2);
    // `load` runs the row through `sanitizeWorkerConfig`, so the stage defaults
    // are here; what must not be is a column named after an Object method.
    expect(Object.keys(loaded ?? {})).not.toContain('toString');
  });
});

describe('loadWorkerConfigSafe', () => {
  test('answers null rather than throwing when the read fails', async () => {
    const broken = {
      read: async (): Promise<never[]> => {
        throw new Error('database unreachable');
      },
      write: async () => ({ changes: 0, lastInsertRowid: 0 }),
      transaction: async () => [],
    };
    expect(await loadWorkerConfigSafe('thumb', broken)).toBeNull();
  });

  test('returns the config when the read succeeds', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await new WorkerConfigRepo(db).upsert('thumb', FULL);
    expect(await loadWorkerConfigSafe('thumb', db)).toEqual(FULL);
  });
});

describe('listWorkerConfigs', () => {
  test('returns every row, name included, for the status surface', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const repo = new WorkerConfigRepo(db);
    await repo.upsert('thumb', FULL);
    await repo.upsert('exif', { ...FULL, concurrency: 2 });
    const byName = new Map(
      (await listWorkerConfigs(db)).map((doc) => [doc.name, sanitizeWorkerConfig(doc)]),
    );
    expect(byName.get('thumb')?.concurrency).toBe(4);
    expect(byName.get('exif')?.concurrency).toBe(2);
  });
});

describe('discover', () => {
  test('answers defaults when the row has never been written', async () => {
    using handle = await createTestDatabase();
    expect(await loadDiscoverConfig(testSqliteDb(handle.db))).toEqual({
      paused: false,
      sweepDirIntervalMs: 250,
    });
  });

  test('round-trips its own knobs', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await patchDiscoverConfig({ paused: true, sweepDirIntervalMs: 1000 }, db);
    expect(await loadDiscoverConfig(db)).toEqual({ paused: true, sweepDirIntervalMs: 1000 });
  });

  test('a partial patch falls back to the default for the field it omits', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await patchDiscoverConfig({ paused: true }, db);
    expect(await loadDiscoverConfig(db)).toEqual({ paused: true, sweepDirIntervalMs: 250 });
  });

  test('shares one row with the stage repo without colliding with it', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await patchDiscoverConfig({ sweepDirIntervalMs: 50 }, db);
    // The operator's pause button drives every worker through the same repo,
    // discover included.
    await new WorkerConfigRepo(db).patch('discover', { paused: true });
    expect(await loadDiscoverConfig(db)).toEqual({ paused: true, sweepDirIntervalMs: 50 });
  });
});
