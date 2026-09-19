import { describe, it, expect, afterEach } from 'bun:test';
import { createLiveTestDatabase } from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { stageRegistry } from '../registry.ts';
import { registerDiscoverWorker, unregisterDiscoverWorker, DISCOVER_NAME } from './register.ts';

afterEach(() => unregisterDiscoverWorker());

describe('registerDiscoverWorker', () => {
  it('appears in statuses() and pause() flips paused', async () => {
    // A live handle, because `pause` writes the sweeper's `worker_config` row
    // through the process-wide database rather than through an override.
    using live = await createLiveTestDatabase();
    void live;
    registerDiscoverWorker();
    expect(DISCOVER_NAME in stageRegistry.statuses()).toBe(true);
    await stageRegistry.pause(DISCOVER_NAME); // writes worker_config + cachedPaused
    expect(stageRegistry.statuses()[DISCOVER_NAME].status).toBe('paused');
  });
});
