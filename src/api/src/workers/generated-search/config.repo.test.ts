/**
 * Integration tests for the generated-search config repo, against real SQLite.
 *
 * The paused-by-default test is the load-bearing one. The worker calls an LLM
 * and writes rows that surface on a widget and a television; a fresh install
 * must not start doing that before an operator has configured Ollama and looked
 * at the output. Same stance as geocode's `pausedOnFirstBoot`.
 *
 * `loadGeneratedSearchConfig` / `saveGeneratedSearchConfig` take no database
 * argument — they reach `app_settings` through `readAppSettings` /
 * `patchAppSettings`, which resolve the process-wide handle — so each test
 * installs its own database with `createLiveTestDatabase`. One per test rather
 * than one per file: a fresh database IS the reset the old suite spelled as a
 * `deleteMany({ _id: 'generated_search' })` between tests.
 */

import { describe, it, expect } from 'bun:test';
import { createLiveTestDatabase } from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { loadGeneratedSearchConfig, saveGeneratedSearchConfig } from './config.repo.ts';

describe('generated-search config — defaults', () => {
  it('starts PAUSED when nothing has been configured', async () => {
    // A fresh install must not call an LLM and publish collections to a
    // living-room screen before an operator has enabled it.
    using _live = await createLiveTestDatabase();
    expect((await loadGeneratedSearchConfig()).paused).toBe(true);
  });

  it('supplies sane defaults for every knob', async () => {
    using _live = await createLiveTestDatabase();
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
  it('round-trips an operator edit', async () => {
    using _live = await createLiveTestDatabase();
    await saveGeneratedSearchConfig({ collections_per_day: 6, paused: false, model: 'ornith:35b' });
    const config = await loadGeneratedSearchConfig();

    expect(config.collections_per_day).toBe(6);
    expect(config.paused).toBe(false);
    expect(config.model).toBe('ornith:35b');
  });

  it('leaves untouched knobs at their defaults', async () => {
    using _live = await createLiveTestDatabase();
    await saveGeneratedSearchConfig({ paused: false });
    const config = await loadGeneratedSearchConfig();
    expect(config.paused).toBe(false);
    expect(config.min_results).toBe(8);
  });

  it('saves one knob without disturbing a knob saved earlier', async () => {
    // The atomicity `patchAppSettings` exists for: a second settings save must
    // not read-modify-write the whole document and drop the first one's field.
    using _live = await createLiveTestDatabase();
    await saveGeneratedSearchConfig({ model: 'ornith:35b' });
    await saveGeneratedSearchConfig({ collections_per_day: 6 });
    const config = await loadGeneratedSearchConfig();
    expect(config.model).toBe('ornith:35b');
    expect(config.collections_per_day).toBe(6);
  });

  it('clamps an out-of-range knob instead of storing it', async () => {
    // An operator typo must not wedge the worker into asking for 900
    // collections a day.
    using _live = await createLiveTestDatabase();
    const config = await saveGeneratedSearchConfig({ collections_per_day: 900 });
    expect(config.collections_per_day).toBe(12);
  });

  it('falls back to the default for a non-finite value', async () => {
    using _live = await createLiveTestDatabase();
    const config = await saveGeneratedSearchConfig({ min_results: Number.NaN });
    expect(config.min_results).toBe(8);
  });

  it('ignores a knob of the wrong type rather than storing junk', async () => {
    using _live = await createLiveTestDatabase();
    const config = await saveGeneratedSearchConfig({
      collections_per_day: 'lots',
    } as never);
    expect(config.collections_per_day).toBe(4);
  });
});
