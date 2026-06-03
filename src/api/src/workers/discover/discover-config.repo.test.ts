import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { getDb } from '../../db/client.ts';
let reachable = true;
beforeAll(async () => { try { await getDb(); } catch { reachable = false; } });
beforeEach(async () => { if (reachable) await (await getDb()).collection('worker_config').deleteMany({ name: 'discover' }); });

describe('discover-config.repo', () => {
  it('returns defaults when unset, persists patches', async () => {
    if (!reachable) return;
    const repo = await import('./discover-config.repo.ts');
    expect(await repo.loadDiscoverConfig()).toEqual({ paused: false, sweepDirIntervalMs: 250 });
    await repo.patchDiscoverConfig({ sweepDirIntervalMs: 1000 });
    expect((await repo.loadDiscoverConfig()).sweepDirIntervalMs).toBe(1000);
  });
});
