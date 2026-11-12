/**
 * Import rows driven end to end through a real Temporal server, beside the job
 * lane they share a host with. One throwaway server is shared by the file;
 * every test brings its own database, its own folders and its own host.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { ObjectId } from '../db/object-id.ts';
import type { ImportStatus, JobStatus } from '../db/schema.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  run,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { importLane } from '../imports/import-queue.ts';
import { importWorkflowId } from '../imports/import-workflow.ts';
import { createImport, getImport } from '../imports/repo.ts';
import { retryImport } from '../imports/retry.ts';
import type { ImportRunnerDeps } from '../imports/worker.ts';
import type { JobHandler } from '../job-runner/handlers/index.ts';
import { jobLane } from '../job-runner/job-queue.ts';
import { createJob, getJob } from '../job-runner/jobs.repo.ts';
import { gate, startLocalTemporalServer, until } from './local-temporal.test-helpers.ts';
import { saveTemporalSettings } from './temporal-config.ts';
import { TemporalHost } from './temporal-host.ts';

const FAST = { relayMs: 20, refreshMs: 100, retryMs: 100 };

let env: TestWorkflowEnvironment;
let tmp: string;

beforeAll(async () => {
  env = await startLocalTemporalServer();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-import-lane-'));
}, 120_000);

afterAll(async () => {
  await env.teardown();
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

const importStatus = (id: ObjectId, status: ImportStatus) =>
  until(
    () => getImport(id),
    (row) => row?.status === status,
  );

const jobStatus = (id: ObjectId, status: JobStatus) =>
  until(
    () => getJob(id),
    (job) => job?.status === status,
  );

/** A pending import of one image staged under `<tmp>/<sub>/src`; `staged: false` leaves the source missing. */
async function pendingImport(db: Database, sub: string, staged = true) {
  const source = path.join(tmp, sub, 'src');
  const lib = path.join(tmp, sub, 'lib');
  await fs.mkdir(source, { recursive: true });
  const src = path.join(source, 'IMG.dng');
  if (staged) await fs.writeFile(src, sub);
  const created = await createImport({
    source_root: source,
    library_id: new ObjectId(insertFolder(db, { path: lib })),
    library_root: lib,
    files: [
      {
        src,
        dest: '2024/03/IMG.dng',
        size: 1,
        mtime: 0,
        kind: 'image',
        state: 'pending',
        error: null,
      },
    ],
  });
  return { id: created._id, src, lib };
}

async function hostFor(
  handleEvent: ImportRunnerDeps['handleEvent'],
  handleJob: JobHandler['run'] = async () => ({ kind: 'done', result: {} }),
): Promise<TemporalHost> {
  await saveTemporalSettings({ address: env.address, namespace: 'default' });
  const host = new TemporalHost({
    ...FAST,
    lanes: [
      jobLane({ handlers: { batch_jpeg_export: { run: handleJob } } }),
      importLane({ deps: { assetExistsForHash: async () => false, handleEvent } }),
    ],
  });
  host.start();
  return host;
}

describe('imports on Temporal', () => {
  test('a pending import becomes a workflow, copies, and ends done', async () => {
    using live = await createLiveTestDatabase();
    const host = await hostFor(async () => {});
    try {
      const { id, lib } = await pendingImport(live.db, 'happy');

      const done = await importStatus(id, 'done');

      expect(done?.counts).toEqual({ copied: 1, skipped: 0, failed: 0 });
      expect(await fs.readFile(path.join(lib, '2024/03/IMG.dng'), 'utf8')).toBe('happy');
      const workflow = env.client.workflow.getHandle(importWorkflowId(id.toHexString()));
      expect(await workflow.result()).toBe('done');
      expect((await workflow.describe()).status.name).toBe('COMPLETED');
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('imports run one at a time, in the order they were created', async () => {
    using live = await createLiveTestDatabase();
    const order: string[] = [];
    let inFlight = 0;
    let overlapped = false;
    const host = await hostFor(async (event) => {
      inFlight += 1;
      overlapped ||= inFlight > 1;
      order.push((event as { absPath: string }).absPath);
      await new Promise((resolve) => setTimeout(resolve, 60));
      inFlight -= 1;
    });
    try {
      const created = [];
      for (let n = 0; n < 4; n += 1) {
        created.push(await pendingImport(live.db, `ordered-${n}`));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      await importStatus(created.at(-1)!.id, 'done');

      expect(overlapped).toBe(false);
      expect(order).toEqual(created.map(({ lib }) => path.join(lib, '2024/03/IMG.dng')));
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('an import finishes while a job is still running', async () => {
    using live = await createLiveTestDatabase();
    const job = gate();
    const host = await hostFor(
      async () => {},
      async () => {
        await job.blocked;
        return { kind: 'done', result: {} };
      },
    );
    try {
      const exporting = await createJob({
        kind: 'batch_jpeg_export',
        payload: { assetIds: [], outputDir: '/tmp', quality: 80 },
      });
      await jobStatus(exporting._id, 'running');
      const { id } = await pendingImport(live.db, 'beside-job');

      await importStatus(id, 'done');

      expect((await getJob(exporting._id))?.status).toBe('running');
      job.release();
      await jobStatus(exporting._id, 'done');
    } finally {
      job.release();
      await host.stop();
    }
  }, 60_000);

  test('a retried import runs again under the same workflow id', async () => {
    using live = await createLiveTestDatabase();
    const host = await hostFor(async () => {});
    try {
      const { id, src, lib } = await pendingImport(live.db, 'retried', false);
      await importStatus(id, 'failed');
      const workflow = env.client.workflow.getHandle(importWorkflowId(id.toHexString()));
      const firstRun = (await workflow.describe()).runId;

      await fs.writeFile(src, 'retried');
      expect(await retryImport(id)).toBe(true);

      expect((await importStatus(id, 'done'))?.counts.copied).toBe(1);
      expect(await fs.readFile(path.join(lib, '2024/03/IMG.dng'), 'utf8')).toBe('retried');
      const secondRun = await until(
        async () => (await workflow.describe()).runId,
        (runId) => runId !== firstRun,
      );
      expect(secondRun).not.toBe(firstRun);
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('an import left running by the old import runner is adopted at connect', async () => {
    using live = await createLiveTestDatabase();
    const { id } = await pendingImport(live.db, 'adopted');
    run(
      live.db,
      `UPDATE imports SET status = 'running', locked_by = 'import-worker-123-abc' WHERE id = ?`,
      id.toHexString(),
    );
    const host = await hostFor(async () => {});
    try {
      expect((await importStatus(id, 'done'))?.counts.copied).toBe(1);
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('a workflow terminated in Temporal cancels its import and lets the next one run', async () => {
    using live = await createLiveTestDatabase();
    const copy = gate();
    const host = await hostFor(async () => {
      await copy.blocked;
    });
    try {
      const stopped = await pendingImport(live.db, 'terminated');
      await importStatus(stopped.id, 'running');
      const next = await pendingImport(live.db, 'after-terminated');

      await env.client.workflow.getHandle(importWorkflowId(stopped.id.toHexString())).terminate();

      await importStatus(stopped.id, 'cancelled');
      copy.release();
      await importStatus(next.id, 'done');
      expect((await getImport(stopped.id))?.status).toBe('cancelled');
    } finally {
      copy.release();
      await host.stop();
    }
  }, 60_000);
});
