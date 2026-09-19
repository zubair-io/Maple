/**
 * Integration test for the run entry point, against real SQLite.
 *
 * Scope is deliberately the pause gate: it is the one behaviour that must
 * hold before anything else runs, and asserting it needs no LLM. The loop
 * itself is covered exhaustively in `loop.test.ts` with injected
 * dependencies; re-testing it here through a live Ollama call would make the
 * suite depend on a model being installed.
 *
 * `runGeneratedSearchOnce` reaches the database through several repositories
 * that take no override, so each test installs its own with
 * `createLiveTestDatabase` and seeds through it.
 */

import { describe, it, expect } from 'bun:test';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { runGeneratedSearchOnce } from './run.ts';
import { saveGeneratedSearchConfig } from './config.repo.ts';

const NOW = new Date('2026-08-17T06:00:00.000Z');
const LIBRARY = 'x';

/** One stored collection, dated so the retention window decides its fate. */
function seedCollection(live: LiveTestDatabase, theme: string, generatedAt: string): void {
  live.db.run(
    `INSERT INTO generated_searches
       (id, library_id, generated_for, generated_at, model, attempts,
        theme, title, subtitle, query, result_count, cover_asset_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      theme.padStart(24, '0'),
      LIBRARY,
      generatedAt.slice(0, 10),
      generatedAt,
      'ornith:35b',
      1,
      theme,
      theme,
      null,
      '{}',
      12,
      null,
    ],
  );
}

function storedThemes(live: LiveTestDatabase): string[] {
  return (
    live.db.query(`SELECT theme FROM generated_searches ORDER BY generated_at`).all() as {
      theme: string;
    }[]
  ).map((row) => row.theme);
}

describe('runGeneratedSearchOnce — pause gate', () => {
  it('does nothing at all while paused', async () => {
    // No Ollama is configured in this suite, so reaching the LLM would throw
    // or hang. Returning cleanly is itself the assertion that the gate is
    // checked before any work starts.
    using _live = await createLiveTestDatabase();
    const summary = await runGeneratedSearchOnce(NOW);

    expect(summary.skipped).toBe(true);
    expect(summary.saved).toBe(0);
    expect(summary.libraries).toBe(0);
  });

  it('writes nothing to the table while paused', async () => {
    using live = await createLiveTestDatabase();
    await runGeneratedSearchOnce(NOW);
    expect(storedThemes(live)).toEqual([]);
  });

  it('still prunes expired collections while paused', async () => {
    // Retention is a promise about disk/DB growth, not about the LLM run.
    // A worker paused for months must not let generated_searches grow (or
    // linger) unbounded just because no new proposals are being made.
    using live = await createLiveTestDatabase();
    seedCollection(live, 'ancient', '2026-01-01T00:00:00.000Z');
    seedCollection(live, 'fresh', '2026-08-16T00:00:00.000Z');

    const summary = await runGeneratedSearchOnce(NOW);

    expect(summary.skipped).toBe(true);
    expect(summary.pruned).toBe(1);
    expect(storedThemes(live)).toEqual(['fresh']);
  });

  it('is paused by default rather than requiring an explicit opt-out', async () => {
    using _live = await createLiveTestDatabase();
    await saveGeneratedSearchConfig({ collections_per_day: 2 });
    const summary = await runGeneratedSearchOnce(NOW);
    expect(summary.skipped).toBe(true);
  });
});
