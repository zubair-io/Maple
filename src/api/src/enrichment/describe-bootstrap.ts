/**
 * Describe-worker bootstrap. Mirror of `bootstrap.ts` for the geocode
 * worker — owns the env+DB-driven on/off switch, the startup health
 * check, and the singleton instance.
 *
 * Behaviour:
 *
 *   - `describe_worker_enabled = false` → no-op. Returns null.
 *   - Provider is Ollama → uses the resolved URL (default
 *     `http://localhost:11434`); no API key required.
 *   - Provider is Anthropic / OpenAI / Gemini → reads
 *     `MAPLE_${PROVIDER}_API_KEY` from env. Fails fast at boot when
 *     unset (the factory throws synchronously).
 *   - `provider.health()` fails → log + leave the previous worker
 *     alone. The operator can fix the URL / key from
 *     `/settings/enrichment` and the next save reconfigures live.
 *
 * Pool sizing (per spec): 1 worker for Ollama (CPU-bound locally),
 * 4 for paid providers (network-bound; provider rate limits dominate).
 * The worker count is encoded as N parallel `DescribeWorker` instances
 * sharing this module-level state, so swapping providers also rewires
 * the pool.
 *
 * Spec: `docs/indexer-enrichment.md` §6 + §8.
 */

import { child as childLogger } from "../log.ts";
import {
  DescribeWorker,
} from "./describe-worker.ts";
import {
  getDescribeProvider,
  RemoteError,
  type DescribeProvider,
} from "./describe-providers/index.ts";
import {
  loadEnrichmentConfig,
  resolveEnrichmentConfig,
  type ResolvedEnrichmentConfig,
} from "./enrichment-config.repo.ts";

const log = childLogger("describe");

/** Pool sizes per provider. Ollama is CPU/GPU-bound on a local box, so
 * one worker is enough; paid providers are network-bound and benefit
 * from parallelism up to the API rate limit. */
const POOL_SIZE: Record<ResolvedEnrichmentConfig["describe_provider"], number> = {
  ollama: 1,
  anthropic: 4,
  openai: 4,
  gemini: 4,
};

let workers: DescribeWorker[] = [];

/**
 * Build the worker(s), run the provider health check, and start the loop.
 * Returns the running pool (empty when disabled or misconfigured).
 */
export async function startDescribeWorker(): Promise<DescribeWorker[]> {
  const dbConfig = await loadEnrichmentConfig();
  const resolved = resolveEnrichmentConfig(dbConfig);
  await applyResolved(resolved);
  return workers;
}

/**
 * Re-apply settings after the operator changes them via the UI. Same
 * shape as `applyEnrichmentConfig` for the geocode worker — the route
 * calls both after a successful save.
 */
export async function applyDescribeConfig(
  resolved: ResolvedEnrichmentConfig,
): Promise<void> {
  await applyResolved(resolved);
}

/** Graceful shutdown — called from the SIGTERM handler. */
export async function stopDescribeWorker(): Promise<void> {
  if (workers.length === 0) return;
  log.info({ count: workers.length }, "describe workers stopping");
  await Promise.all(workers.map((w) => w.shutdown()));
  workers = [];
  log.info("describe workers stopped");
}

/** Internal: shared boot + reapply path. */
async function applyResolved(
  resolved: ResolvedEnrichmentConfig,
): Promise<void> {
  const desiredEnabled = resolved.describe_worker_enabled;

  if (!desiredEnabled) {
    if (workers.length > 0) {
      log.info("describe worker disabled — stopping pool");
      await Promise.all(workers.map((w) => w.shutdown()));
      workers = [];
    } else {
      log.info("describe worker disabled (describe_worker_enabled=false)");
    }
    return;
  }

  // Build the provider. Paid providers throw synchronously when the API
  // key is missing — catch it so the rest of the boot continues (the
  // operator can fix it via /settings/enrichment without a restart).
  let provider: DescribeProvider;
  try {
    provider = getDescribeProvider(resolved.describe_provider, {
      url: resolved.describe_provider_url,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      { err: msg, provider: resolved.describe_provider },
      "describe provider misconfigured; leaving previous workers alone (fix via /settings/enrichment)",
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
      "describe provider health check failed; leaving previous workers alone (fix via /settings/enrichment)",
    );
    return;
  }

  // Replace the running pool only after the new provider passes health.
  if (workers.length > 0) {
    log.info("restarting describe workers for updated config");
    await Promise.all(workers.map((w) => w.shutdown()));
    workers = [];
  }

  const poolSize = POOL_SIZE[resolved.describe_provider];
  const pool: DescribeWorker[] = [];
  for (let i = 0; i < poolSize; i++) {
    const worker = new DescribeWorker({
      provider,
      systemPrompt: resolved.describe_system_prompt,
      model: resolved.describe_model,
      dailyCapUsd: resolved.describe_daily_cap_usd,
      workerId: `describe-${process.pid}-${i}`,
    });
    worker.start();
    pool.push(worker);
  }
  workers = pool;
  log.info(
    { provider: provider.name, pool: poolSize },
    "describe workers started",
  );
}

/** Test-only: peek at the running pool without spawning one. */
export function _getWorkersForTests(): DescribeWorker[] {
  return workers;
}
