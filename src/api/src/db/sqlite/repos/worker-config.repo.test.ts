/**
 * `worker_config`, ported case for case from
 * `workers/worker-config.repo.test.ts` and the `bootConfig` half of
 * `workers/run-stage.test.ts`.
 *
 * The Mongo suites run against a hand-rolled collection fake that applies
 * `$set` and ignores `$setOnInsert` and `$unset` — which means the upsert
 * semantics they depend on were never actually exercised. Here they run against
 * the real table, so the `NOT NULL` columns and the `ON CONFLICT` branch are
 * part of what passes.
 */

import { describe, expect, test } from 'bun:test';
import { WorkerConfigRepo, bootConfig, type WorkerConfig } from './worker-config.repo.ts';
import { testSqliteDb } from './assets.test-helpers.ts';
import { createTestDatabase } from '../test-sqlite.test-helpers.ts';

const SEEDED: WorkerConfig = {
  concurrency: 4,
  maxAttempts: 5,
  paused: false,
  last_seen_target_version: 1,
};

const stage = (defaults: Partial<WorkerConfig & { pausedOnFirstBoot: boolean }> = {}) => ({
  name: 'describe',
  defaults: {
    concurrency: 4,
    maxAttempts: 5,
    paused: false,
    last_seen_target_version: 0,
    pausedOnFirstBoot: false,
    ...defaults,
  },
});

describe('WorkerConfigRepo', () => {
  test('load returns null for a stage that has never been seeded', async () => {
    using handle = await createTestDatabase();
    const repo = new WorkerConfigRepo(testSqliteDb(handle.db));

    expect(await repo.load('describe')).toBeNull();
  });

  test('upsert inserts, then replaces', async () => {
    using handle = await createTestDatabase();
    const repo = new WorkerConfigRepo(testSqliteDb(handle.db));

    await repo.upsert('describe', SEEDED);
    const inserted = await repo.load('describe');
    await repo.upsert('describe', { ...SEEDED, concurrency: 8, paused: true });
    const replaced = await repo.load('describe');

    expect(inserted).toEqual(SEEDED);
    expect(replaced).toEqual({ ...SEEDED, concurrency: 8, paused: true });
  });

  test('patch touches only the fields it was given', async () => {
    using handle = await createTestDatabase();
    const repo = new WorkerConfigRepo(testSqliteDb(handle.db));
    await repo.upsert('describe', { ...SEEDED, concurrency: 2 });

    await repo.patch('describe', { concurrency: 4 });

    expect(await repo.load('describe')).toEqual(SEEDED);
  });

  test('patch creates the row when the stage has not booted yet', async () => {
    using handle = await createTestDatabase();
    const repo = new WorkerConfigRepo(testSqliteDb(handle.db));

    // `PATCH /api/workers/:name/config` can land before a stage's first boot,
    // and silently no-opping there loses the operator's change.
    await repo.patch('describe', { paused: true, pause_reason: 'policy' });

    expect(await repo.load('describe')).toMatchObject({
      paused: true,
      pause_reason: 'policy',
    });
  });

  test('a pause with no reason has no pause_reason key at all', async () => {
    using handle = await createTestDatabase();
    const repo = new WorkerConfigRepo(testSqliteDb(handle.db));

    await repo.upsert('describe', { ...SEEDED, paused: true });
    const config = await repo.load('describe');

    // An operator pause carries no explanation, and surfacing a permanent
    // `pause_reason: null` on every row is what the Workers page branches on
    // not seeing (#3315).
    expect(config).not.toHaveProperty('pause_reason');
  });

  test('a self-imposed pause reason round-trips', async () => {
    using handle = await createTestDatabase();
    const repo = new WorkerConfigRepo(testSqliteDb(handle.db));
    await repo.upsert('describe', SEEDED);

    await repo.patch('describe', {
      paused: true,
      pause_reason: 'Paused automatically: embedder address policy',
    });

    expect(await repo.load('describe')).toMatchObject({
      paused: true,
      pause_reason: 'Paused automatically: embedder address policy',
    });
  });

  test('every resume clears the reason, even one that did not mention it', async () => {
    using handle = await createTestDatabase();
    const repo = new WorkerConfigRepo(testSqliteDb(handle.db));
    await repo.upsert('describe', { ...SEEDED, paused: true, pause_reason: 'policy' });

    await repo.patch('describe', { paused: false });

    // The reason describes the pause it came with, and every resume path — the
    // button, PATCH /config, the in-process registry — goes through `patch`, so
    // none of them can leave a stale explanation on a running stage.
    expect(await repo.load('describe')).not.toHaveProperty('pause_reason');
  });

  test('an unrelated knob leaves an existing reason alone', async () => {
    using handle = await createTestDatabase();
    const repo = new WorkerConfigRepo(testSqliteDb(handle.db));
    await repo.upsert('describe', { ...SEEDED, paused: true, pause_reason: 'policy' });

    await repo.patch('describe', { concurrency: 9 });

    expect(await repo.load('describe')).toMatchObject({ concurrency: 9, pause_reason: 'policy' });
  });

  test('the AI knobs and the operator label survive a round trip', async () => {
    using handle = await createTestDatabase();
    const repo = new WorkerConfigRepo(testSqliteDb(handle.db));

    await repo.upsert('describe', {
      ...SEEDED,
      version: 'v0.2.1',
      prompt_text: 'describe the scene',
      ai_provider: 'ollama',
      ai_model: 'qwen2.5-vl',
    });

    expect(await repo.load('describe')).toEqual({
      ...SEEDED,
      version: 'v0.2.1',
      prompt_text: 'describe the scene',
      ai_provider: 'ollama',
      ai_model: 'qwen2.5-vl',
    });
  });
});

describe('bootConfig', () => {
  test('seeds the defaults on first boot and persists them', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);

    const booted = await bootConfig(stage(), db);

    expect(booted).toEqual({
      concurrency: 4,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 0,
    });
    expect(await new WorkerConfigRepo(db).load('describe')).toEqual(booted);
  });

  test('a stage that needs configuration it may not have starts paused', async () => {
    using handle = await createTestDatabase();

    const booted = await bootConfig(stage({ pausedOnFirstBoot: true }), testSqliteDb(handle.db));

    // This is the guard against a version-gated stage marking every asset
    // permanently handled before the configuration it needs exists: a paused
    // stage never claims, so it never reaches the return path that sets
    // `version` to target. `geocode` is the existing caller.
    expect(booted.paused).toBe(true);
  });

  test('the saved value wins on every boot after the first', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await new WorkerConfigRepo(db).upsert('describe', {
      ...SEEDED,
      concurrency: 8,
      paused: true,
    });

    const booted = await bootConfig(stage({ pausedOnFirstBoot: false }), db);

    expect(booted).toMatchObject({ concurrency: 8, paused: true });
  });

  test('repairs the integer fields of a row a PATCH created before first boot', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await new WorkerConfigRepo(db).patch('describe', { paused: false });

    const booted = await bootConfig(stage(), db);

    // A row missing `concurrency` reaches the claim as a non-integer batch
    // size, which is a crash rather than a misconfiguration.
    expect(Number.isInteger(booted.concurrency)).toBe(true);
    expect(booted.concurrency).toBe(4);
    expect(booted.maxAttempts).toBe(5);
    expect(booted.paused).toBe(false);
  });
});
