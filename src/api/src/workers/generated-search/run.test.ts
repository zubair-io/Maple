/**
 * Integration test for the run entry point.
 *
 * Scope is deliberately the pause gate: it is the one behaviour that must
 * hold before anything else runs, and asserting it needs no LLM. The loop
 * itself is covered exhaustively in `loop.test.ts` with injected
 * dependencies; re-testing it here through a live Ollama call would make the
 * suite depend on a model being installed.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import type { Db } from 'mongodb';
import { getDb } from '../../db/client.ts';
import { withTestDb } from '../../db/test-db.test-helpers.ts';
import { runGeneratedSearchOnce } from './run.ts';
import { saveGeneratedSearchConfig } from './config.repo.ts';

// Own database + explicit close (the repo-wide suite convention, #2783).
withTestDb(`maple_test_generated_search_run_${process.pid}`);

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

async function reset(): Promise<void> {
  await db.collection('app_settings').deleteMany({ _id: 'generated_search' } as never);
}

describe('runGeneratedSearchOnce — pause gate', () => {
  beforeEach(reset);

  it('does nothing at all while paused', async () => {
    // No Ollama is configured in this suite, so reaching the LLM would throw
    // or hang. Returning cleanly is itself the assertion that the gate is
    // checked before any work starts.
    const summary = await runGeneratedSearchOnce(new Date('2026-08-17T06:00:00.000Z'));

    expect(summary.skipped).toBe(true);
    expect(summary.saved).toBe(0);
    expect(summary.libraries).toBe(0);
  });

  it('writes nothing to the collection while paused', async () => {
    await runGeneratedSearchOnce(new Date('2026-08-17T06:00:00.000Z'));
    expect(await db.collection('generated_searches').countDocuments()).toBe(0);
  });

  it('is paused by default rather than requiring an explicit opt-out', async () => {
    await saveGeneratedSearchConfig({ collections_per_day: 2 });
    const summary = await runGeneratedSearchOnce(new Date('2026-08-17T06:00:00.000Z'));
    expect(summary.skipped).toBe(true);
  });
});
