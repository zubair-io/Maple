import { describe, expect, it, mock } from 'bun:test';
import {
  bootConfig,
  defineStage,
  notifyConfigChange,
  type StageConfig,
  type WorkerConfig,
} from './stage-config.ts';
import { createTestDatabase, testSqliteDb } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { WorkerConfigRepo } from '../db/repos/worker-config.repo.ts';

const initial: WorkerConfig = {
  concurrency: 2,
  maxAttempts: 3,
  paused: false,
  last_seen_target_version: 1,
  ai_provider: 'ollama',
  ai_model: 'original',
  prompt_text: 'original instructions',
  version: 'v0.1.0',
};
const stage = defineStage({
  name: 'describe',
  targetVersion: 1,
  dependsOn: [],
  defaults: { ...initial, pausedOnFirstBoot: true },
  handler: async () => ({ patch: [] }),
}) as StageConfig;

describe('AI worker configuration lifecycle', () => {
  it('retains provider, model, instructions and label across worker boot', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const repo = new WorkerConfigRepo(db);
    await repo.upsert(stage.name, initial);
    expect(await bootConfig(stage, db)).toEqual(initial);
    expect(await repo.load(stage.name)).toEqual(initial);
  });

  it('invalidates dependencies for runtime changes but not an operator label', () => {
    const invalidate = mock(() => {});
    const worker = { ...stage, onConfigChange: invalidate };
    for (const patch of [
      { ai_provider: 'anthropic' },
      { ai_model: 'new-model' },
      { prompt_text: 'new instructions' },
      { prompt_text: null },
      { concurrency: 4 },
    ]) {
      notifyConfigChange(worker, { ...initial, ...patch }, initial);
    }
    expect(invalidate).toHaveBeenCalledTimes(5);
    notifyConfigChange(worker, { ...initial, version: 'v0.2.0' }, initial);
    notifyConfigChange(worker, { ...initial }, initial);
    expect(invalidate).toHaveBeenCalledTimes(5);
  });

  it('contains asynchronous invalidation failures', async () => {
    const warn = mock(() => {});
    const worker = {
      ...stage,
      onConfigChange: async () => {
        throw new Error('failed hook');
      },
    };
    notifyConfigChange(worker, { ...initial, ai_model: 'new' }, initial, { warn });
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
