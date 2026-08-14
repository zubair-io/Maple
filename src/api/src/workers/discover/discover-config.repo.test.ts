import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'bun:test';
import { closeDb, getDb } from '../../db/client.ts';
// Own per-pid database + explicit close — the repo-wide suite convention
// (#2835): otherwise this file operates on whatever database MAPLE_MONGO_DB
// happens to name (the real `maple` dev DB when it runs first) and leaks its
// singleton connection into later suites (the #2783 flake class).
const TEST_DB = `maple_test_discover_config_repo_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

let reachable = true;
beforeAll(async () => {
  try {
    await closeDb();
    await getDb();
  } catch {
    reachable = false;
  }
});
beforeEach(async () => {
  if (reachable) await (await getDb()).collection('worker_config').deleteMany({ name: 'discover' });
});
afterAll(async () => {
  if (reachable) await (await getDb()).dropDatabase();
  await closeDb();
});

describe('discover-config.repo', () => {
  it('returns defaults when unset, persists patches', async () => {
    if (!reachable) return;
    const repo = await import('./discover-config.repo.ts');
    expect(await repo.loadDiscoverConfig()).toEqual({ paused: false, sweepDirIntervalMs: 250 });
    await repo.patchDiscoverConfig({ sweepDirIntervalMs: 1000 });
    expect((await repo.loadDiscoverConfig()).sweepDirIntervalMs).toBe(1000);
  });
});
