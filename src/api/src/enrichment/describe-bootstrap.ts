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

import { child as childLogger } from "../log.ts";
import {
  getDescribeProvider,
  RemoteError,
} from "./describe-providers/index.ts";
import {
  loadEnrichmentConfig,
  resolveEnrichmentConfig,
  type ResolvedEnrichmentConfig,
} from "./enrichment-config.repo.ts";

const log = childLogger("describe");

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
 * Re-apply settings after the operator changes them via the UI.
 * Runs the provider health check and logs any misconfiguration.
 */
export async function applyDescribeConfig(
  resolved: ResolvedEnrichmentConfig,
): Promise<void> {
  if (!resolved.describe_worker_enabled) {
    log.info("describe worker disabled (describe_worker_enabled=false)");
    return;
  }

  let provider;
  try {
    provider = getDescribeProvider(resolved.describe_provider, {
      url: resolved.describe_provider_url,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      { err: msg, provider: resolved.describe_provider },
      "describe provider misconfigured (fix via /settings/enrichment)",
    );
    return;
  }

  try {
    log.info(
      { provider: provider.name, model: resolved.describe_model },
      "checking describe-provider health",
    );
    await provider.health();
    log.info({ provider: provider.name }, "describe provider healthy");
  } catch (err) {
    const status =
      err instanceof RemoteError && err.status !== undefined
        ? err.status
        : null;
    log.error(
      {
        err: err instanceof Error ? err.message : err,
        provider: provider.name,
        status,
      },
      "describe provider health check failed (fix via /settings/enrichment)",
    );
  }
}

/** Lifecycle hook called at shutdown. No-op — stage-controller runtime handles teardown. */
export async function stopDescribeWorker(): Promise<void> {
  log.info("describe bootstrap stop called (stage-controller runtime owns lifecycle)");
}

/** Test-only: no workers in Plan 3+ — returns empty array. */
export function _getWorkersForTests(): never[] {
  return [];
}
