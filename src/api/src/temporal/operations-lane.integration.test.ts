/**
 * Operator one-shots driven end to end through a real Temporal server: folder
 * scans and mirror reconciles relayed on the operations lane beside a blocked
 * user job, a reconcile left behind by a dead process finished by the next
 * one, and the derivative-audit and generated-search run-now requests started
 * on the maintenance lane. One throwaway server is shared by the file.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { replaceFolderDestinations } from '../cloud-backup/local-mirror-bridge.ts';
import type { ObjectId } from '../db/object-id.ts';
import type { JobStatus } from '../db/schema.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { saveEnrichmentConfig } from '../enrichment/enrichment-config.repo.ts';
import { clearMirrorRoots } from '../fs/mirror-registry.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { jobLane } from '../job-runner/job-queue.ts';
import { createJob, getJob } from '../job-runner/jobs.repo.ts';
import { operationLane } from '../job-runner/operation-queue.ts';
import { loadDerivativeAuditProgress } from '../workers/derivative-audit/progress.ts';
import { loadRunRecords } from '../workers/generated-search/run-state.repo.ts';
import { maintenanceLane, maintenanceRunNowId } from '../workers/maintenance/lane.ts';
import {
  pendingMaintenanceRuns,
  requestMaintenanceRun,
} from '../workers/maintenance/run-now.repo.ts';
import { MAINTENANCE_TASKS } from '../workers/maintenance/tasks.ts';
import { reconcileProgressOf } from '../workers/mirror/reconcile-progress.ts';
import { startLocalTemporalServer } from './local-temporal.test-helpers.ts';
import { saveTemporalSettings } from './temporal-config.ts';
import type { TemporalLane } from './temporal-lane.ts';
import { TemporalHost } from './temporal-host.ts';

const FAST = { relayMs: 20, refreshMs: 100, retryMs: 100 };
const EXPORT_PAYLOAD = { assetIds: [], outputDir: '/tmp', quality: 80 };

let env: TestWorkflowEnvironment;
let primary: string;
let mirror: string;

beforeAll(async () => {
  env = await startLocalTemporalServer();
}, 120_000);

afterAll(async () => {
  await env.teardown();
});

beforeEach(() => {
  primary = mkdtempSync(join(tmpdir(), 'operations-primary-'));
  mirror = mkdtempSync(join(tmpdir(), 'operations-mirror-'));
  invalidateLibraryRoots();
  clearMirrorRoots();
});

afterEach(() => {
  clearMirrorRoots();
  invalidateLibraryRoots();
  rmSync(primary, { recursive: true, force: true });
  rmSync(mirror, { recursive: true, force: true });
});

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const jobStatus = (id: ObjectId, status: JobStatus) =>
  until(
    () => getJob(id),
    (job) => job?.status === status,
  );

async function hostFor(lanes: TemporalLane[]): Promise<TemporalHost> {
  await saveTemporalSettings({ address: env.address, namespace: 'default' });
  const host = new TemporalHost({ ...FAST, lanes });
  host.start();
  return host;
}

describe('operations lane', () => {
  test('a folder scan finishes while a user job holds the jobs lane', async () => {
    using live = await createLiveTestDatabase();
    writeFileSync(join(primary, 'IMG.dng'), 'raw bytes');
    const folderId = insertFolder(live.db, { path: primary, slug: 'scan' });
    let releaseExport = () => {};
    const exportBlocked = new Promise<void>((resolve) => {
      releaseExport = resolve;
    });
    const host = await hostFor([
      jobLane({
        handlers: {
          batch_jpeg_export: {
            run: async () => {
              await exportBlocked;
              return { kind: 'done', result: {} };
            },
          },
        },
      }),
      operationLane(),
    ]);
    try {
      const exportJob = await createJob({ kind: 'batch_jpeg_export', payload: EXPORT_PAYLOAD });
      await jobStatus(exportJob._id, 'running');

      const scan = await createJob({ kind: 'folder_scan', payload: { folderId } });
      const scanned = await jobStatus(scan._id, 'done');

      expect((await getJob(exportJob._id))?.status).toBe('running');
      expect(scanned?.result).toEqual({ last_scan: expect.any(String) });
      releaseExport();
      await jobStatus(exportJob._id, 'done');
    } finally {
      releaseExport();
      await host.stop();
    }
  }, 60_000);

  test('a reconcile left running by a process that died is run again to done', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = insertFolder(live.db, { path: primary, slug: 'reconcile' });
    writeFileSync(join(primary, 'IMG.dng'), 'raw bytes');
    insertLocation(live.db, {
      assetId: insertAsset(live.db),
      libraryId,
      path: '',
      filename: 'IMG.dng',
    });
    await replaceFolderDestinations(libraryId, [{ path: mirror, enabled: true }]);
    const job = await createJob({ kind: 'mirror_reconcile', payload: {} });
    run(
      live.db,
      `UPDATE jobs SET status = 'running', locked_by = 'worker-41-dead',
          lease_expires_at = '2026-01-01T00:00:00.000Z',
          ledger = json('{"reconcile":{"phase":"copying"}}')
        WHERE id = ?`,
      job._id.toHexString(),
    );
    const host = await hostFor([operationLane()]);
    try {
      const done = await jobStatus(job._id, 'done');

      expect(readFileSync(join(mirror, 'IMG.dng'), 'utf8')).toBe('raw bytes');
      expect(reconcileProgressOf(done)).toMatchObject({
        phase: 'idle',
        copy: { copied: 1, remaining: 0, errors: 0 },
      });
    } finally {
      await host.stop();
    }
  }, 60_000);
});

describe('run-now on the maintenance lane', () => {
  const runNowTasks = MAINTENANCE_TASKS.filter((task) =>
    ['derivative-audit', 'generated-search'].includes(task.id),
  );

  const finishedRun = async (taskId: string) => {
    const workflow = env.client.workflow.getHandle(maintenanceRunNowId(taskId));
    await until(
      () =>
        workflow.describe().then(
          (description) => description.status.name,
          () => 'MISSING',
        ),
      (status) => status === 'COMPLETED',
    );
  };

  test('a derivative-audit request runs a forced pass while the audit is disabled', async () => {
    using _live = await createLiveTestDatabase();
    const host = await hostFor([maintenanceLane(runNowTasks)]);
    try {
      await requestMaintenanceRun('derivative-audit', { force: true });

      await finishedRun('derivative-audit');

      const progress = await loadDerivativeAuditProgress();
      expect(progress.savedAt).not.toBeNull();
      expect(progress.summary).toMatchObject({ running: false, finishedAt: expect.any(String) });
      await until(pendingMaintenanceRuns, (pending) => pending.length === 0);
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('a generated-search request runs a pass for every library', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = insertFolder(live.db, { path: primary, slug: 'generated' });
    await saveEnrichmentConfig({ describe_provider_url: 'http://127.0.0.1:9' });
    const host = await hostFor([maintenanceLane(runNowTasks)]);
    try {
      await requestMaintenanceRun('generated-search', { force: true });

      await finishedRun('generated-search');

      expect((await loadRunRecords()).get(libraryId)).toMatchObject({
        finished_at: expect.any(String),
      });
      await until(pendingMaintenanceRuns, (pending) => pending.length === 0);
    } finally {
      await host.stop();
    }
  }, 60_000);
});
