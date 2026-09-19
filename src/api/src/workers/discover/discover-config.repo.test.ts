/**
 * The `worker_config` row's own behaviour — defaults, clamping, the mixture of
 * stage and sweeper columns on one row — is covered by
 * `db/sqlite/repos/worker-config.repo.test.ts`. What matters here is that the
 * sweeper's import path still reaches it against the process-wide handle.
 */
import { describe, it, expect } from 'bun:test';
import { createLiveTestDatabase } from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { loadDiscoverConfig, patchDiscoverConfig } from './discover-config.repo.ts';

describe('discover-config.repo', () => {
  it('returns defaults when unset, persists patches', async () => {
    using live = await createLiveTestDatabase();
    void live;
    expect(await loadDiscoverConfig()).toEqual({ paused: false, sweepDirIntervalMs: 250 });
    await patchDiscoverConfig({ sweepDirIntervalMs: 1000 });
    expect((await loadDiscoverConfig()).sweepDirIntervalMs).toBe(1000);
  });
});
