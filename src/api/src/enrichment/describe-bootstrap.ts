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
import { getDescribeProvider, RemoteError } from './describe-providers/index.ts';
import { loadEnrichmentConfig, QWEN_VL_OLLAMA_TAG } from './enrichment-config.repo.ts';
import {
  resolveEnrichmentConfig,
  type ResolvedEnrichmentConfig,
} from './enrichment-config.resolve.ts';
import { resetDescribeDeps } from '../workers/stages/describe.ts';

const log = childLogger('describe');

/** Logged at boot for operator visibility. Single source of truth for
 * the Ollama tag lives in `enrichment-config.repo.ts`. */
const LOCKED_MODEL = QWEN_VL_OLLAMA_TAG;

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
 * claim, then health-checks Ollama at the new URL.
 *
 * Provider and model are locked — the stage handler ignores
 * `describe_provider` / `describe_model` / `describe_system_prompt`, so this
 * bootstrap does too. Logging the locked model rather than the resolved
 * field avoids misleading operators who still have stale paid-provider
 * values in their pre-#157 config row.
 */
export async function applyDescribeConfig(resolved: ResolvedEnrichmentConfig): Promise<void> {
  // Invalidate any cached provider in the stage handler so the URL change
  // takes effect without a restart. Safe to call unconditionally — the
  // next claim will lazily re-resolve.
  resetDescribeDeps();

  if (!resolved.describe_worker_enabled) {
    log.info('describe worker disabled (describe_worker_enabled=false)');
    return;
  }

  let provider;
  try {
    provider = getDescribeProvider('ollama', {
      url: resolved.describe_provider_url,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'describe provider misconfigured (fix via /settings/enrichment)');
    return;
  }

  try {
    log.info({ provider: provider.name, model: LOCKED_MODEL }, 'checking describe-provider health');
    await provider.health();
    log.info({ provider: provider.name }, 'describe provider healthy');
  } catch (err) {
    const status = err instanceof RemoteError && err.status !== undefined ? err.status : null;
    log.error(
      {
        err: err instanceof Error ? err.message : err,
        provider: provider.name,
        status,
      },
      'describe provider health check failed (fix via /settings/enrichment)',
    );
  }
}

/** Lifecycle hook called at shutdown. No-op — stage-controller runtime handles teardown. */
export async function stopDescribeWorker(): Promise<void> {
  log.info('describe bootstrap stop called (stage-controller runtime owns lifecycle)');
}

/** Test-only: no workers in Plan 3+ — returns empty array. */
export function _getWorkersForTests(): never[] {
  return [];
}
