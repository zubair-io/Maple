import { assignedAiPool } from './ai-assigned-pool.ts';
/**
 * Describe bootstrap — provider health-check and config relay.
 *
 * The bespoke DescribeWorker has been retired (Plan 3). The describe stage
 * is now run by the unified stage-controller runtime (`workers/stages/describe.ts`).
 * This module is retained because `routes/enrichment.ts` and `index.ts` call its
 * exported functions for the operator-settings UI flow (health probing the provider
 * on config save, and graceful start/stop lifecycle hooks).
 *
 * The `startDescribeWorker` / `stopDescribeWorker` no-ops satisfy the lifecycle
 * contract without spawning any workers — the stage-controller supervisor handles
 * spawning. `applyDescribeConfig` still runs the provider health check so the
 * settings UI can surface misconfiguration errors immediately.
 *
 * Spec: `docs/indexer-enrichment.md` §6 + §8.
 */

import { child as childLogger } from '../log.ts';
import { DescribeServerPool } from './describe-server-pool.ts';
import {
  describeServersForRuntime,
  syncDescribeStageCapacity,
} from '../workers/describe-capacity.ts';
import { loadEnrichmentConfig, asDescribeProvider } from './enrichment-config.repo.ts';
import { getDescribeProvider } from './describe-providers/index.ts';
import { loadWorkerConfigSafe } from '../db/repos/worker-config.repo.ts';
import {
  resolveEnrichmentConfig,
  type ResolvedEnrichmentConfig,
} from './enrichment-config.resolve.ts';
import { resetDescribeDeps } from '../workers/stages/describe.ts';
import { resetVideoDescribeDeps } from '../workers/stages/video-describe.ts';

const log = childLogger('describe');

/**
 * Lifecycle hook called at boot. In Plan 3+ the stage-controller runtime
 * owns the describe stage — this function only validates provider config.
 */
export async function startDescribeWorker(): Promise<never[]> {
  const dbConfig = await loadEnrichmentConfig();
  const resolved = resolveEnrichmentConfig(dbConfig);
  await applyDescribeConfig(resolved);
  return [];
}

/**
 * Re-apply settings after the operator changes them via the UI. Invalidates
 * the stage handler's cached deps so a URL change takes effect on the next
 * claim, then health-checks the selected provider. Only Ollama derives
 * stage concurrency from the server list; paid providers retain the
 * operator's stage concurrency.
 */
export async function applyDescribeConfig(resolved: ResolvedEnrichmentConfig): Promise<void> {
  // Invalidate any cached provider in the stage handler so the URL change
  // takes effect without a restart. Safe to call unconditionally — the
  // next claim will lazily re-resolve. `video-describe` (#2158) reads the
  // same `describe_servers` config through its own cached pool, so it
  // needs the same invalidation or a saved server-list change would apply
  // to `describe` but leave video-describe on the stale pool until restart.
  resetDescribeDeps();
  resetVideoDescribeDeps();

  const assigned = assignedAiPool(resolved.ai_connections, 'describe');
  if (assigned) {
    await syncDescribeStageCapacity(assigned.pool.capacity);
    return;
  }
  if (!resolved.describe_worker_enabled) {
    log.info('describe worker disabled (describe_worker_enabled=false)');
    return;
  }

  const worker = await loadWorkerConfigSafe('describe');
  const provider = asDescribeProvider(worker?.ai_provider ?? '') ?? resolved.describe_provider;
  if (provider !== 'ollama') {
    try {
      await getDescribeProvider(provider, { apiKey: resolved[`${provider}_api_key`] }).health();
      log.info({ provider }, 'describe provider healthy');
    } catch (err) {
      log.error({ provider, err }, 'describe provider health check failed');
    }
    return;
  }

  // Every configured server is probed, not just the default one: in a
  // multi-server pool "describe is unhealthy" is useless when one of three
  // boxes is down and the other two are serving fine. A dead server is
  // logged and left in the pool — the stage fails over past it per call and
  // picks it back up when it recovers, so a transient outage needs no
  // operator action.
  // Building the pool is the one step here that can throw synchronously (an
  // empty server list; a future provider whose constructor validates its
  // endpoint). Misconfiguration must stay a logged, recoverable condition —
  // the operator fixes it in /settings/workers without a restart — so it is
  // caught here rather than rejecting `applyDescribeConfig` and taking the
  // rest of this apply with it.
  const servers = await describeServersForRuntime(resolved);
  let pool: DescribeServerPool;
  try {
    pool = new DescribeServerPool(servers);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : err },
      'describe servers misconfigured (fix via /settings/workers)',
    );
    return;
  }
  // Keep the stage's dispatch fan-out equal to the pool's total capacity.
  // Otherwise a claimed asset either sits holding a lease waiting for
  // admission (fan-out too high) or servers idle with backlog waiting
  // (too low). The operator tunes per-server concurrency; this is derived.
  await syncDescribeStageCapacity(pool.capacity);

  log.info(
    { servers: pool.servers.map((s) => s.url), model: worker?.ai_model ?? resolved.describe_model },
    'checking describe-server health',
  );
  const results = await pool.health();
  for (const result of results) {
    if (result.ok) log.info({ server: result.url }, 'describe server healthy');
    else
      log.error(
        { server: result.url, err: result.error },
        'describe server health check failed (fix via /settings/workers)',
      );
  }
  if (!results.some((result) => result.ok)) {
    log.error('no describe server is reachable — the stage will retry every claim');
  }
}

/** Lifecycle hook called at shutdown. No-op — stage-controller runtime handles teardown. */
export async function stopDescribeWorker(): Promise<void> {
  log.info('describe bootstrap stop called (stage-controller runtime owns lifecycle)');
}
