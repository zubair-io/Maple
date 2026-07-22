/**
 * Geocode enrichment bootstrap.
 *
 * NOTE (Plan 3): The bespoke `GeocodeWorker` has been retired. Reverse
 * geocoding is now handled by the unified stage-controller runtime at
 * `src/api/src/workers/stages/geocode.ts`. This file is retained because
 * it owns the enrichment-config health-check wiring used by the settings UI
 * (`applyEnrichmentConfig`) and the API route that tests the Nominatim URL.
 *
 * The worker lifecycle functions (`startGeocodeWorker`, `stopGeocodeWorker`)
 * are kept as no-ops so existing call sites in `src/index.ts` compile until
 * they are removed in the Task 6 supervisor refactor.
 *
 * Spec: `docs/indexer-enrichment.md` §4.2 (boot health check), §6 (wiring).
 */

import { child as childLogger } from '../log.ts';
import type { CircuitBreakerConfig } from './circuit-breaker.ts';
import { NominatimClient } from './nominatim-client.ts';
import { loadEnrichmentConfig } from './enrichment-config.repo.ts';
import {
  resolveEnrichmentConfig,
  type ResolvedEnrichmentConfig,
} from './enrichment-config.resolve.ts';

const log = childLogger('geocode');

export interface GeocodeBootstrapOptions {
  /** Override for tests. */
  breakerConfig?: CircuitBreakerConfig;
}

/**
 * No-op stub. In Plan 3+, the geocode stage is started by the stage-controller
 * supervisor. Retained so `src/index.ts` compiles until Task 6 removes the call.
 */
export async function startGeocodeWorker(_opts: GeocodeBootstrapOptions = {}): Promise<null> {
  const dbConfig = await loadEnrichmentConfig();
  const resolved = resolveEnrichmentConfig(dbConfig);
  if (resolved.geocode_worker_enabled && resolved.nominatim_url) {
    const client = new NominatimClient({
      baseUrl: resolved.nominatim_url,
      rateLimitPerSec: resolved.nominatim_rate_limit_per_sec,
    });
    log.info({ url: resolved.nominatim_url }, 'checking Nominatim status');
    await client.health();
    log.info('Nominatim healthy');
  }
  return null;
}

/**
 * Re-apply enrichment config from the settings UI. Runs a Nominatim health
 * check when a URL is present so the UI can surface connectivity errors.
 */
export async function applyEnrichmentConfig(resolved: ResolvedEnrichmentConfig): Promise<void> {
  if (!resolved.geocode_worker_enabled || !resolved.nominatim_url) {
    log.info('geocode worker disabled or no URL — skipping health check');
    return;
  }
  const client = new NominatimClient({
    baseUrl: resolved.nominatim_url,
    rateLimitPerSec: resolved.nominatim_rate_limit_per_sec,
  });
  log.info({ url: resolved.nominatim_url }, 'checking Nominatim status');
  await client.health();
  log.info('Nominatim healthy');
}

/** No-op stub — worker lifecycle is owned by the stage-controller runtime. */
export async function stopGeocodeWorker(): Promise<void> {
  // No-op: the stage-controller runtime handles graceful shutdown.
}
