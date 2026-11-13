/**
 * Each stage's stall threshold is a setting in worker_config, edited from
 * Settings → Workers like concurrency and max attempts (#5038).
 */
import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { workerRoutes } from './routes.ts';
import { WorkerConfigRepo } from '../db/repos/worker-config.repo.ts';
import { stageRegistry } from './registry.ts';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';

function registerFakeStage(name: string): void {
  stageRegistry._resetForTests();
  stageRegistry.register(name, {
    targetVersion: 1,
    dependsOn: [],
    getInFlight: () => 0,
    getThroughput: () => 0,
    getPaused: () => false,
    reloadConfig: async () => {},
    pause: async () => {},
    resume: async () => {},
  });
}

function patch(name: string, body: unknown): Promise<Response> {
  return new Elysia().use(workerRoutes()).handle(
    new Request(`http://localhost/api/workers/${name}/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('stall threshold setting', () => {
  it('persists a stage stall threshold and reads it back', async () => {
    using _live = await createLiveTestDatabase();
    registerFakeStage('cloud-backup');

    const res = await patch('cloud-backup', { stallAfterMinutes: 120 });

    expect(res.status).toBe(200);
    expect((await new WorkerConfigRepo().load('cloud-backup'))?.stallAfterMinutes).toBe(120);
  });

  it('rejects a threshold outside 5 minutes to a day', async () => {
    registerFakeStage('cloud-backup');
    expect((await patch('cloud-backup', { stallAfterMinutes: 4 })).status).toBe(422);
    expect((await patch('cloud-backup', { stallAfterMinutes: 1441 })).status).toBe(422);
  });
});
