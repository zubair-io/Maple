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
  await Promise.all([
    db.collection('app_settings').deleteMany({ _id: 'generated_search' } as never),
    db.collection('generated_searches').deleteMany({}),
  ]);
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

  it('still prunes expired collections while paused', async () => {
    // Retention is a promise about disk/DB growth, not about the LLM run.
    // A worker paused for months must not let generated_searches grow (or
    // linger) unbounded just because no new proposals are being made.
    await db.collection('generated_searches').insertMany([
      { library_id: 'x', theme: 'ancient', generated_at: '2026-01-01T00:00:00.000Z' },
      { library_id: 'x', theme: 'fresh', generated_at: '2026-08-16T00:00:00.000Z' },
    ] as never);

    const summary = await runGeneratedSearchOnce(new Date('2026-08-17T06:00:00.000Z'));

    expect(summary.skipped).toBe(true);
    expect(summary.pruned).toBe(1);
    const left = await db.collection('generated_searches').find({}).toArray();
    expect(left.map((d) => d.theme)).toEqual(['fresh']);
  });

  it('is paused by default rather than requiring an explicit opt-out', async () => {
    await saveGeneratedSearchConfig({ collections_per_day: 2 });
    const summary = await runGeneratedSearchOnce(new Date('2026-08-17T06:00:00.000Z'));
    expect(summary.skipped).toBe(true);
  });
});
