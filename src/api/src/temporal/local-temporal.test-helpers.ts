import { setTimeout as sleep } from 'node:timers/promises';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { jobLane } from '../job-runner/job-queue.ts';
import { saveTemporalSettings } from './temporal-config.ts';
import { TemporalHost } from './temporal-host.ts';

/**
 * Pinned so every machine runs the same server, and so the binary CI fetches
 * ahead of time (`scripts/prewarm-temporal.ts`) is the one the tests then find
 * in the cache.
 */
const TEMPORAL_CLI_VERSION = 'v1.10.0';

/** A host stopped mid-connect cannot be interrupted, and a fixture must exit within seconds of SIGTERM. */
const STOP_GRACE_MS = 1_000;

/** A throwaway Temporal server on an ephemeral port; the caller tears it down. */
export function startLocalTemporalServer(): Promise<TestWorkflowEnvironment> {
  return TestWorkflowEnvironment.createLocal({
    server: { executable: { type: 'cached-download', version: TEMPORAL_CLI_VERSION } },
  });
}

export interface LocalTemporal {
  env: TestWorkflowEnvironment;
  host: TemporalHost;
  stop: () => Promise<void>;
}

/**
 * A throwaway server saved as the process-wide database's Temporal setting,
 * with a host already running user jobs on it. The caller must have installed
 * its test database first. Only the jobs lane is served: the fixture servers
 * that use this exercise batch sync and export, and a lane they never use
 * would pull its whole import graph into what their native consumers depend on
 * (`tools/ci_changes.py`).
 */
export async function startLocalTemporal(): Promise<LocalTemporal> {
  const env = await startLocalTemporalServer();
  await saveTemporalSettings({ address: env.address, namespace: env.namespace ?? 'default' });
  const host = new TemporalHost({ relayMs: 20, lanes: [jobLane()] });
  host.start();
  return {
    env,
    host,
    stop: async () => {
      await Promise.race([host.stop(), sleep(STOP_GRACE_MS)]);
      await env.teardown();
    },
  };
}

/** Re-reads until `done` holds, failing with the last value read after `ms`. */
export async function until<T>(
  read: () => T | Promise<T>,
  done: (value: T) => boolean,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(value)}`);
    await sleep(25);
  }
}

/** A promise a test holds a handler on until it calls `release`. */
export function gate(): { blocked: Promise<void>; release: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { blocked: promise, release: () => resolve() };
}
