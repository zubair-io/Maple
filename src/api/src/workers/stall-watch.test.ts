/**
 * A stage that holds or keeps claiming work, or whose poll loop stops turning,
 * with no progress for its stall threshold is reported as stalled on Settings
 * → Workers (#5038); deferrals are claims, not progress.
 */
import { describe, expect, it, beforeEach } from 'bun:test';
import { StallWatch } from './stall-watch.ts';
import { stageRegistry, type StageRegistryEntry } from './registry.ts';

const start = 1_000_000;
const threshold = 60 * 60_000;

describe('StallWatch', () => {
  it('is not stalled while work keeps completing', () => {
    const watch = new StallWatch(() => threshold, start);
    watch.polled(start + threshold);
    watch.claimed(5, 0, start + threshold - 1000);
    watch.progressed(start + threshold - 1000);
    expect(watch.stalledForMs(3, start + threshold + 1000)).toBeNull();
  });

  it('is stalled when work is held but nothing completes', () => {
    const watch = new StallWatch(() => threshold, start);
    watch.claimed(3, 0, start);
    watch.polled(start + threshold);
    expect(watch.stalledForMs(3, start + threshold)).toBe(threshold);
  });

  it('is stalled when every claim keeps deferring', () => {
    const watch = new StallWatch(() => threshold, start);
    for (let t = start; t <= start + threshold; t += 60_000) {
      watch.polled(t);
      watch.claimed(10, 0, t);
    }
    expect(watch.stalledForMs(0, start + threshold)).toBe(threshold);
  });

  it('is stalled when the poll loop stops turning', () => {
    const watch = new StallWatch(() => threshold, start);
    watch.polled(start);
    expect(watch.stalledForMs(0, start + threshold)).toBe(threshold);
  });

  it('is not stalled when an idle stage picks up its first work', () => {
    const watch = new StallWatch(() => threshold, start);
    for (let t = start; t <= start + 2 * threshold; t += 60_000) watch.polled(t);
    watch.claimed(1, 0, start + 2 * threshold);
    expect(watch.stalledForMs(1, start + 2 * threshold + 1000)).toBeNull();
  });

  it('is not stalled when there is simply no work', () => {
    const watch = new StallWatch(() => threshold, start);
    for (let t = start; t <= start + 3 * threshold; t += 60_000) watch.polled(t);
    expect(watch.stalledForMs(0, start + 3 * threshold)).toBeNull();
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
    stageRegistry.register('cloud-backup', entry({ getStalledForMs: () => 80 * 60_000 }));
    expect(stageRegistry.statuses()['cloud-backup']).toMatchObject({
      status: 'stalled',
      lastError: 'No progress for 80 minutes while work is waiting',
    });
  });

  it('a paused stage is reported as paused, not stalled', () => {
    stageRegistry.register(
      'cloud-backup',
      entry({ getPaused: () => true, getStalledForMs: () => 80 * 60_000 }),
    );
    expect(stageRegistry.statuses()['cloud-backup']?.status).toBe('paused');
  });
});
