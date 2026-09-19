/**
 * Register `discover` as a controllable worker so /api/workers/status + the
 * generic pause/resume/config routes cover it. The sweeper itself runs in a
 * child; these callbacks only touch worker_config (the child polls it).
 */
import { stageRegistry } from '../registry.ts';
import { loadDiscoverConfig, patchDiscoverConfig } from './discover-config.repo.ts';

export const DISCOVER_NAME = 'discover';
let cachedPaused = false;

export function registerDiscoverWorker(): void {
  stageRegistry.register(DISCOVER_NAME, {
    targetVersion: 0,
    dependsOn: [],
    getInFlight: () => 0,
    getThroughput: () => 0,
    getPaused: () => cachedPaused,
    reloadConfig: async () => {
      cachedPaused = (await loadDiscoverConfig()).paused;
    },
    pause: async () => {
      await patchDiscoverConfig({ paused: true });
      cachedPaused = true;
    },
    resume: async () => {
      await patchDiscoverConfig({ paused: false });
      cachedPaused = false;
    },
  });
  // Prime the cached flag. Deliberately not awaited — registration happens on
  // the boot path — and deliberately caught: a read that loses a race with the
  // database opening must leave the worker running with its default rather than
  // raise an unhandled rejection. `reloadConfig` re-reads on the next tick.
  void loadDiscoverConfig()
    .then((c) => {
      cachedPaused = c.paused;
    })
    .catch(() => {});
}

export function unregisterDiscoverWorker(): void {
  stageRegistry.unregister(DISCOVER_NAME);
}
