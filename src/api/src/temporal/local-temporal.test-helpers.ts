import { TestWorkflowEnvironment } from '@temporalio/testing';
import { saveTemporalSettings } from './temporal-config.ts';
import { TemporalHost } from './temporal-host.ts';

/**
 * Pinned so every machine runs the same server, and so the binary CI fetches
 * ahead of time (`scripts/prewarm-temporal.ts`) is the one the tests then find
 * in the cache.
 */
const TEMPORAL_CLI_VERSION = 'v1.10.0';

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
 * with a host already serving it. The caller must have installed its test
 * database first.
 */
export async function startLocalTemporal(): Promise<LocalTemporal> {
  const env = await startLocalTemporalServer();
  await saveTemporalSettings({ address: env.address, namespace: env.namespace ?? 'default' });
  const host = new TemporalHost({ relayMs: 20 });
  host.start();
  return {
    env,
    host,
    stop: async () => {
      await host.stop();
      await env.teardown();
    },
  };
}
