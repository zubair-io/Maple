/**
 * A stage that holds or keeps claiming work but makes no progress for
 * STALL_AFTER_MS is reported as stalled on Settings → Workers (#5038);
 * deferrals are claims, not progress.
 */
import { describe, expect, it, beforeEach } from 'bun:test';
import { STALL_AFTER_MS, StallWatch } from './stall-watch.ts';
import { stageRegistry, type StageRegistryEntry } from './registry.ts';

const start = 1_000_000;

describe('StallWatch', () => {
  it('is not stalled while work keeps completing', () => {
    const watch = new StallWatch(start);
    watch.claimed(5, start + STALL_AFTER_MS - 1000);
    watch.progressed(start + STALL_AFTER_MS - 1000);
    expect(watch.stalledForMs(3, start + STALL_AFTER_MS + 1000)).toBeNull();
  });

  it('is stalled when work is held but nothing completes', () => {
    const watch = new StallWatch(start);
    watch.claimed(3, start);
    expect(watch.stalledForMs(3, start + STALL_AFTER_MS)).toBe(STALL_AFTER_MS);
  });

  it('is stalled when every claim keeps deferring', () => {
    const watch = new StallWatch(start);
    for (let t = start; t <= start + STALL_AFTER_MS; t += 60_000) watch.claimed(10, t);
    expect(watch.stalledForMs(0, start + STALL_AFTER_MS)).toBe(STALL_AFTER_MS);
  });

  it('is not stalled when there is simply no work', () => {
    const watch = new StallWatch(start);
    expect(watch.stalledForMs(0, start + 10 * STALL_AFTER_MS)).toBeNull();
  });
});

describe('StageRegistry stall status', () => {
  beforeEach(() => stageRegistry._resetForTests());

  function entry(overrides: Partial<StageRegistryEntry>): StageRegistryEntry {
    return {
      targetVersion: 1,
      dependsOn: [],
      getInFlight: () => 2,
      getThroughput: () => 0,
      getPaused: () => false,
      reloadConfig: async () => {},
      pause: async () => {},
      resume: async () => {},
      ...overrides,
    };
  }

  it('reports a stalled stage with an explanation', () => {
    stageRegistry.register('cloud-backup', entry({ getStalledForMs: () => 20 * 60_000 }));
    expect(stageRegistry.statuses()['cloud-backup']).toMatchObject({
      status: 'stalled',
      lastError: 'No progress for 20 minutes while work is waiting',
    });
  });

  it('a paused stage is reported as paused, not stalled', () => {
    stageRegistry.register(
      'cloud-backup',
      entry({ getPaused: () => true, getStalledForMs: () => 20 * 60_000 }),
    );
    expect(stageRegistry.statuses()['cloud-backup']?.status).toBe('paused');
  });
});
