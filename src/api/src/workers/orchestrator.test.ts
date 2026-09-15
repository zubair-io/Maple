import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { startAllStages, stopAllStages } from './orchestrator.ts';
import { stageRegistry } from './registry.ts';
import { ALL_STAGE_NAMES, stageRegistrations } from './stages/manifest.ts';

const restored: Array<{ mockRestore(): void }> = [];

beforeEach(() => stageRegistry._resetForTests());
afterEach(async () => {
  await stopAllStages();
  for (const spy of restored.splice(0)) spy.mockRestore();
  stageRegistry._resetForTests();
});

describe('canonical stage boot', () => {
  it('pre-registers every stage before any starter runs and drains all handles', async () => {
    const stopped: string[] = [];
    const started: string[] = [];
    for (const name of ALL_STAGE_NAMES) {
      restored.push(
        spyOn(stageRegistrations[name], 'start').mockImplementation(async () => {
          expect(Object.keys(stageRegistry.statuses())).toEqual([...ALL_STAGE_NAMES]);
          started.push(name);
          return {
            stop: async () => {
              stopped.push(name);
            },
          };
        }),
      );
    }
    await startAllStages();
    expect(started).toEqual([...ALL_STAGE_NAMES]);
    await stopAllStages();
    expect(stopped).toEqual([...ALL_STAGE_NAMES]);
  });

  it('keeps failed stages visible and retries without restarting healthy stages', async () => {
    const calls = new Map<string, number>();
    for (const name of ALL_STAGE_NAMES) {
      restored.push(
        spyOn(stageRegistrations[name], 'start').mockImplementation(async () => {
          const attempt = (calls.get(name) ?? 0) + 1;
          calls.set(name, attempt);
          if (name === 'describe' && attempt === 1) throw new Error('temporary boot failure');
          return { stop: async () => {} };
        }),
      );
    }
    await startAllStages();
    expect(stageRegistry.statuses().describe?.status).toBe('error');
    expect(Object.keys(stageRegistry.statuses())).toEqual([...ALL_STAGE_NAMES]);
    const deadline = Date.now() + 3000;
    while ((calls.get('describe') ?? 0) < 2 && Date.now() < deadline) await Bun.sleep(20);
    expect(calls.get('describe')).toBe(2);
    expect(stageRegistry.statuses().describe?.lastError).toBeNull();
    for (const name of ALL_STAGE_NAMES.filter((stage) => stage !== 'describe')) {
      expect(calls.get(name)).toBe(1);
    }
  });
});
