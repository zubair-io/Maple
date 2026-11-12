/**
 * The discover sweep driven end to end through a real Temporal server: one
 * workflow per registered library root, slices of the real sweep over real
 * directories, and the connection check that keeps a workflow running for every
 * root. One throwaway server is shared by the file; every test brings its own
 * database, its own library roots and its own host. Events go to a recorder
 * rather than the real producer, so a file the sweep finds is reported again on
 * every generation.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { NativeConnection, Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { readCheckpoint } from '../db/repos/indexer-checkpoints.repo.ts';
import { patchDiscoverConfig } from '../db/repos/worker-config.repo.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  run,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { discoverLane } from '../workers/discover/discover-lane.ts';
import { DISCOVER_TASK_QUEUE, discoverWorkflowId } from '../workers/discover/discover-workflow.ts';
import type { WatchEvent } from '../workers/discover/types.ts';
import { startLocalTemporalServer } from './local-temporal.test-helpers.ts';
import { readTemporalStatus, saveTemporalSettings } from './temporal-config.ts';
import { TemporalHost } from './temporal-host.ts';
import { discoverWorkflow } from './workflows.ts';

const FAST = { relayMs: 20, refreshMs: 100, retryMs: 100 };

let env: TestWorkflowEnvironment;
let tmp: string;

beforeAll(async () => {
  env = await startLocalTemporalServer();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-discover-lane-'));
}, 120_000);

afterAll(async () => {
  await env.teardown();
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
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

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A library root on disk holding the named files; subdirectories are created as needed. */
async function libraryWith(name: string, files: readonly string[]): Promise<string> {
  const root = path.join(tmp, name);
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), file);
  }
  await fs.mkdir(root, { recursive: true });
  return root;
}

function recorder() {
  const created = new Set<string>();
  let events = 0;
  return {
    created,
    count: () => events,
    handleEvent: async (event: WatchEvent) => {
      events += 1;
      if (event.kind === 'created') created.add(event.absPath);
    },
  };
}

async function hostFor(handleEvent: (event: WatchEvent) => Promise<void>): Promise<TemporalHost> {
  await patchDiscoverConfig({ paused: false, sweepDirIntervalMs: 0 });
  await saveTemporalSettings({ address: env.address, namespace: 'default' });
  const host = new TemporalHost({ ...FAST, lanes: [discoverLane({ handleEvent })] });
  host.start();
  return host;
}

/** Waits until the host has run `count` connection checks (each one reconciles) after now. */
async function laterChecks(count: number): Promise<void> {
  const since = Date.now();
  const checks: number[] = [];
  await until(
    async () => {
      const { checkedAt } = (await readTemporalStatus()).connection;
      if (checkedAt !== null && checkedAt > since && !checks.includes(checkedAt))
        checks.push(checkedAt);
      return checks.length;
    },
    (seen) => seen >= count,
  );
}

const workflowOf = (folderId: string) =>
  env.client.workflow.getHandle(discoverWorkflowId(folderId));

const describeOf = (folderId: string) =>
  workflowOf(folderId)
    .describe()
    .then(
      ({ status, runId }) => ({ status: status.name, runId }),
      () => ({ status: 'MISSING', runId: '' }),
    );

describe('the discover sweep on Temporal', () => {
  test('files under a registered root are discovered through its workflow', async () => {
    using live = await createLiveTestDatabase();
    const root = await libraryWith('found', ['a.jpg', 'nested/b.dng', 'notes.txt']);
    const folderId = insertFolder(live.db, { path: root });
    const events = recorder();
    const host = await hostFor(events.handleEvent);
    try {
      await until(
        async () => events.created.size,
        (size) => size === 2,
      );

      expect([...events.created].toSorted()).toEqual([
        path.join(root, 'a.jpg'),
        path.join(root, 'nested/b.dng'),
      ]);
      expect((await describeOf(folderId)).status).toBe('RUNNING');
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('a small root sweeps generation after generation inside one activity', async () => {
    using live = await createLiveTestDatabase();
    const root = await libraryWith('one-activity', ['only.jpg']);
    const folderId = insertFolder(live.db, { path: root });
    const events = recorder();
    const host = await hostFor(events.handleEvent);
    try {
      await until(
        async () => (await readCheckpoint(folderId))?.sweepGen ?? 1,
        (generation) => generation >= 4,
      );

      const { events: history } = await workflowOf(folderId).fetchHistory();
      const scheduled = (history ?? []).filter(
        (event) => event.activityTaskScheduledEventAttributes,
      );
      expect(scheduled).toHaveLength(1);
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('a root registered while the host runs starts sweeping without a restart', async () => {
    using live = await createLiveTestDatabase();
    const events = recorder();
    const host = await hostFor(events.handleEvent);
    try {
      await until(readTemporalStatus, (status) => status.connection.state === 'connected');
      const root = await libraryWith('added-later', ['late.jpg']);
      const folderId = insertFolder(live.db, { path: root });

      await until(
        () => describeOf(folderId),
        ({ status }) => status === 'RUNNING',
        2_000,
      );
      await until(
        async () => events.created.has(path.join(root, 'late.jpg')),
        (found) => found,
      );
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('pausing discover stops visits, and resuming carries on', async () => {
    using live = await createLiveTestDatabase();
    const root = await libraryWith('paused', ['first.jpg']);
    insertFolder(live.db, { path: root });
    const events = recorder();
    const host = await hostFor(events.handleEvent);
    try {
      await until(
        async () => events.created.has(path.join(root, 'first.jpg')),
        (found) => found,
      );

      await patchDiscoverConfig({ paused: true });
      await settle(1_500);
      const whilePaused = events.count();
      await fs.writeFile(path.join(root, 'second.jpg'), 'second');
      await settle(2_500);

      expect(events.count()).toBe(whilePaused);
      expect(events.created.has(path.join(root, 'second.jpg'))).toBe(false);

      await patchDiscoverConfig({ paused: false });
      await until(
        async () => events.created.has(path.join(root, 'second.jpg')),
        (found) => found,
      );
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('a workflow terminated in Temporal is started again at the next check', async () => {
    using live = await createLiveTestDatabase();
    const root = await libraryWith('terminated', ['kept.jpg']);
    const folderId = insertFolder(live.db, { path: root });
    const events = recorder();
    const host = await hostFor(events.handleEvent);
    try {
      const first = await until(
        () => describeOf(folderId),
        ({ status }) => status === 'RUNNING',
      );

      await workflowOf(folderId).terminate('operator stopped it');
      const after = path.join(root, 'after-terminate.jpg');
      await fs.writeFile(after, 'after');

      const restarted = await until(
        () => describeOf(folderId),
        ({ status, runId }) => status === 'RUNNING' && runId !== first.runId,
        5_000,
      );
      expect(restarted.runId).not.toBe(first.runId);
      await until(
        async () => events.created.has(after),
        (found) => found,
      );
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('removing a root completes its workflow, and nothing starts it again', async () => {
    using live = await createLiveTestDatabase();
    const root = await libraryWith('removed', ['gone.jpg']);
    const folderId = insertFolder(live.db, { path: root });
    const events = recorder();
    const host = await hostFor(events.handleEvent);
    try {
      await until(
        async () => events.created.has(path.join(root, 'gone.jpg')),
        (found) => found,
      );

      run(live.db, `DELETE FROM folders WHERE id = ?`, folderId);
      const outcome = await workflowOf(folderId).result();
      await laterChecks(2);

      expect(outcome).toBe('gone');
      expect((await describeOf(folderId)).status).toBe('COMPLETED');
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('stopping the host waits for the file event in hand, not the rest of the directory', async () => {
    using live = await createLiveTestDatabase();
    const root = await libraryWith('bounded-stop', ['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg']);
    insertFolder(live.db, { path: root });
    const EVENT_MS = 1_000;
    let started = 0;
    const host = await hostFor(async () => {
      started += 1;
      await settle(EVENT_MS);
    });
    try {
      await until(
        async () => started,
        (count) => count >= 1,
      );
    } finally {
      const stopping = Date.now();
      await host.stop();
      const tookMs = Date.now() - stopping;

      expect(tookMs).toBeLessThan(EVENT_MS + 1_500);
      expect(started).toBeLessThan(5);
    }
  }, 60_000);

  test('a slice whose worker dies resumes on a healthy worker after the heartbeat timeout', async () => {
    using live = await createLiveTestDatabase();
    const root = await libraryWith('crashed', ['survivor.jpg']);
    const folderId = insertFolder(live.db, { path: root });
    await patchDiscoverConfig({ paused: false, sweepDirIntervalMs: 0 });
    const connection = await NativeConnection.connect({ address: env.address });
    let taken = false;
    let release = () => {};
    const silent = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dying = await Worker.create({
      connection,
      taskQueue: DISCOVER_TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)),
      maxConcurrentActivityTaskExecutions: 1,
      activities: {
        sweepRoot: async () => {
          taken = true;
          await silent;
          return {
            generation: 1,
            generationsCompleted: 0,
            directoriesVisited: 0,
            registered: true,
          };
        },
      },
    });
    const dyingRun = dying.run();
    const events = recorder();
    let host: TemporalHost | null = null;
    try {
      await env.client.workflow.start(discoverWorkflow, {
        workflowId: discoverWorkflowId(folderId),
        taskQueue: DISCOVER_TASK_QUEUE,
        args: [folderId],
      });
      await until(
        async () => taken,
        (yes) => yes,
      );
      host = await hostFor(events.handleEvent);

      await until(
        async () => events.created.has(path.join(root, 'survivor.jpg')),
        (found) => found,
        90_000,
      );
    } finally {
      await host?.stop();
      release();
      dying.shutdown();
      await dyingRun;
      await connection.close();
    }
  }, 150_000);
});
