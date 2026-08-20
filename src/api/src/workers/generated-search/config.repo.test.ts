/**
 * Integration tests for the generated-search config repo, against real Mongo.
 *
 * The paused-by-default test is the load-bearing one. The worker calls an LLM
 * and writes collections that surface on a widget and a television; a fresh
 * install must not start doing that before an operator has configured Ollama
 * and looked at the output. Same stance as geocode's `pausedOnFirstBoot`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import type { Db } from 'mongodb';
import { getDb } from '../../db/client.ts';
import { withTestDb } from '../../db/test-db.test-helpers.ts';
import { loadGeneratedSearchConfig, saveGeneratedSearchConfig } from './config.repo.ts';

// Own database + explicit close (the repo-wide suite convention, #2783).
withTestDb(`maple_test_generated_search_config_${process.pid}`);

let db: Db;

beforeAll(async () => {
  db = await getDb();
});
afterAll(async () => {
  // Drop the handle captured in beforeAll. Deliberately NOT closeDb(): that
  // closes the shared client, and because withTestDb registers root-level
  // beforeAll hooks, by teardown the singleton points at another suite's
  // database — closing it here times out that suite's hooks.
  await db.dropDatabase();
});

/** Scoped per describe — a root-level hook is not confined to this file. */
async function reset(): Promise<void> {
  await db.collection('app_settings').deleteMany({ _id: 'generated_search' } as never);
}

describe('generated-search config — defaults', () => {
  beforeEach(reset);

  it('starts PAUSED when nothing has been configured', async () => {
    // A fresh install must not call an LLM and publish collections to a
    // living-room screen before an operator has enabled it.
    expect((await loadGeneratedSearchConfig()).paused).toBe(true);
  });

  it('supplies sane defaults for every knob', async () => {
    const config = await loadGeneratedSearchConfig();
    expect(config.collections_per_day).toBe(4);
    expect(config.min_results).toBe(8);
    expect(config.max_rounds).toBe(3);
    expect(config.retention_days).toBe(30);
    expect(config.dry_run).toBe(false);
    // Empty means "inherit the describe stage's model".
    expect(config.model).toBe('');
  });
});

describe('generated-search config — persistence', () => {
  beforeEach(reset);

  it('round-trips an operator edit', async () => {
    await saveGeneratedSearchConfig({ collections_per_day: 6, paused: false, model: 'ornith:35b' });
    const config = await loadGeneratedSearchConfig();

    expect(config.collections_per_day).toBe(6);
    expect(config.paused).toBe(false);
    expect(config.model).toBe('ornith:35b');
  });

  it('leaves untouched knobs at their defaults', async () => {
    await saveGeneratedSearchConfig({ paused: false });
    const config = await loadGeneratedSearchConfig();
    expect(config.paused).toBe(false);
    expect(config.min_results).toBe(8);
  });

  it('clamps an out-of-range knob instead of storing it', async () => {
    // An operator typo must not wedge the worker into asking for 900
    // collections a day.
    const config = await saveGeneratedSearchConfig({ collections_per_day: 900 });
    expect(config.collections_per_day).toBe(12);
  });

  it('falls back to the default for a non-finite value', async () => {
    const config = await saveGeneratedSearchConfig({ min_results: Number.NaN });
    expect(config.min_results).toBe(8);
  });

  it('ignores a knob of the wrong type rather than storing junk', async () => {
    const config = await saveGeneratedSearchConfig({
      collections_per_day: 'lots',
    } as never);
    expect(config.collections_per_day).toBe(4);
  });
});
