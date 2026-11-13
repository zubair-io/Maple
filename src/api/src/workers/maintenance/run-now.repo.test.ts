import { expect, test } from 'bun:test';
import { createLiveTestDatabase } from '../../db/sqlite/test-sqlite.test-helpers.ts';
import {
  clearMaintenanceRun,
  pendingMaintenanceRuns,
  requestMaintenanceRun,
} from './run-now.repo.ts';

test('nothing is pending on a fresh database', async () => {
  using _live = await createLiveTestDatabase();
  expect(await pendingMaintenanceRuns()).toEqual([]);
});

test('a request is pending with its options until it is cleared', async () => {
  using _live = await createLiveTestDatabase();
  await requestMaintenanceRun('db-backup', { force: true });
  await requestMaintenanceRun('trash-gc');

  const pending = await pendingMaintenanceRuns();
  expect(pending.map(({ taskId, options }) => ({ taskId, options }))).toEqual([
    { taskId: 'db-backup', options: { force: true } },
    { taskId: 'trash-gc', options: {} },
  ]);

  await clearMaintenanceRun(pending[0]!);
  expect((await pendingMaintenanceRuns()).map(({ taskId }) => taskId)).toEqual(['trash-gc']);
});

test('clearing a request that has since been made again keeps the newer one', async () => {
  using _live = await createLiveTestDatabase();
  await requestMaintenanceRun('trash-gc');
  const [first] = await pendingMaintenanceRuns();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await requestMaintenanceRun('trash-gc');

  await clearMaintenanceRun(first!);

  const [kept] = await pendingMaintenanceRuns();
  expect(kept?.requestedAt).not.toBe(first!.requestedAt);
});
