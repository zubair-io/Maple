import { describe, it, expect, afterEach } from 'bun:test';
import { stageRegistry } from '../registry.ts';
import { registerDiscoverWorker, unregisterDiscoverWorker, DISCOVER_NAME } from './register.ts';

afterEach(() => unregisterDiscoverWorker());

describe('registerDiscoverWorker', () => {
  it('appears in statuses() and pause() flips paused', async () => {
    registerDiscoverWorker();
    expect(DISCOVER_NAME in stageRegistry.statuses()).toBe(true);
    await stageRegistry.pause(DISCOVER_NAME); // writes worker_config + cachedPaused
    expect(stageRegistry.statuses()[DISCOVER_NAME].status).toBe('paused');
  });
});
