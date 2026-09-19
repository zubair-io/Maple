/**
 * Upgrade behaviour for a deploy that has never saved a describe server list,
 * and the write that keeps the stage's fan-out equal to its servers' capacity.
 *
 * The list is the new shape; `describe_provider_url` is the old one. Every
 * existing deploy boots with the old one, so the derivation in between has to
 * preserve what that deploy was already doing — same endpoint, same number of
 * concurrent requests — until the operator opts into per-server tuning.
 */

import { describe, expect, it } from 'bun:test';
import { MAX_TOTAL_DESCRIBE_CAPACITY } from '../enrichment/describe-servers.ts';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { WorkerConfigRepo } from '../db/repos/worker-config.repo.ts';
import { describeServersForRuntime, syncDescribeStageCapacity } from './describe-capacity.ts';
import type { ResolvedEnrichmentConfig } from '../enrichment/enrichment-config.resolve.ts';

/** Stand-in for the stage's saved concurrency. No database, and — unlike a
 * module mock — nothing that leaks into the suites sharing this process. */
const stageConcurrency = (value: number | null) => async () => value;

function cfg(source: 'db' | 'derived'): ResolvedEnrichmentConfig {
  return {
    describe_provider_url: 'http://ollama.lan:11434',
    describe_servers:
      source === 'db'
        ? [
            { url: 'http://gpu-a:11434', concurrency: 4 },
            { url: 'http://gpu-b:11434', concurrency: 1 },
          ]
        : [{ url: 'http://ollama.lan:11434', concurrency: 2 }],
    source: { describe_servers: source },
  } as ResolvedEnrichmentConfig;
}

describe('describeServersForRuntime', () => {
  it('uses the saved list verbatim once the operator has one', async () => {
    expect(await describeServersForRuntime(cfg('db'), stageConcurrency(5))).toEqual([
      { url: 'http://gpu-a:11434', concurrency: 4 },
      { url: 'http://gpu-b:11434', concurrency: 1 },
    ]);
  });

  it('carries the stage concurrency onto the derived single server', async () => {
    // The upgrade case that matters: this deploy runs describe at 8 against
    // one URL. It must keep running at 8, not drop to the built-in default
    // because a list it never saved says so.
    expect(await describeServersForRuntime(cfg('derived'), stageConcurrency(8))).toEqual([
      { url: 'http://ollama.lan:11434', concurrency: 8 },
    ]);
  });

  it('falls back to the built-in default on a fresh install', async () => {
    expect(await describeServersForRuntime(cfg('derived'), stageConcurrency(null))).toEqual([
      { url: 'http://ollama.lan:11434', concurrency: 2 },
    ]);
  });
});

/**
 * The write half, against a real database.
 *
 * `syncDescribeStageCapacity` reaches the worker-config repository with no
 * override — it is called from `applyDescribeConfig` in two different
 * processes, neither of which has a handle to pass — so the test installs one
 * process-wide instead of threading it through.
 */
describe('syncDescribeStageCapacity', () => {
  it('writes the total onto a stage that has never been configured', async () => {
    using live = await createLiveTestDatabase();
    await syncDescribeStageCapacity(6);

    expect((await new WorkerConfigRepo().load('describe'))?.concurrency).toBe(6);
    expect(live.db.query(`SELECT COUNT(*) AS n FROM worker_config`).get()).toEqual({ n: 1 });
  });

  it('clamps a total above the ceiling the workers route enforces', async () => {
    // The read path drops unusable entries but not an oversized sum, so a
    // hand-edited config doc can still arrive over the limit. Persisting it
    // would leave a stage concurrency no operator could have set themselves.
    using _live = await createLiveTestDatabase();
    await syncDescribeStageCapacity(MAX_TOTAL_DESCRIBE_CAPACITY + 40);

    expect((await new WorkerConfigRepo().load('describe'))?.concurrency).toBe(
      MAX_TOTAL_DESCRIBE_CAPACITY,
    );
  });

  it('leaves the rest of the stage config alone when it rewrites concurrency', async () => {
    using _live = await createLiveTestDatabase();
    const repo = new WorkerConfigRepo();
    await repo.patch('describe', { concurrency: 2, maxAttempts: 5, paused: true });

    await syncDescribeStageCapacity(9);

    const config = await repo.load('describe');
    expect(config?.concurrency).toBe(9);
    expect(config?.maxAttempts).toBe(5);
    expect(config?.paused).toBe(true);
  });

  it('survives an unreachable database rather than failing the config apply', async () => {
    // No live database installed at all: a hiccup here must never stop the
    // describe config from being applied, and the next refresh tick retries.
    await syncDescribeStageCapacity(4);
  });
});
