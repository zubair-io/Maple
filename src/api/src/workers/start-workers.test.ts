import { expect, test } from 'bun:test';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { stopWorkers } from './start-workers.ts';

test('stopping a worker tier that never started resolves and can be repeated', async () => {
  using _live = await createLiveTestDatabase();
  expect(await stopWorkers()).toBeUndefined();
  expect(await stopWorkers()).toBeUndefined();
});
