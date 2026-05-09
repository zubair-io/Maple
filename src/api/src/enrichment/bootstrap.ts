/**
 * Geocode-worker bootstrap. Owns the env-driven on/off switch, the startup
 * health check, and the singleton instance. Imported by `src/index.ts`
 * after the DB connection is up.
 *
 * Behaviour:
 *
 *   - `MAPLE_GEOCODE_WORKER_ENABLED=false` → no-op. Returns null.
 *   - `MAPLE_NOMINATIM_URL` unset      → log + no-op (don't crash; the
 *     operator may run Maple without geocoding).
 *   - `client.health()` fails          → throw. The caller should log loud
 *     and exit the process — a typo in the URL or an un-booted Nominatim
 *     should fail at startup, not silently dead-letter every claim.
 *
 * The DB-backed `app_settings.enrichment` row overrides the env vars at
 * boot, and `applyEnrichmentConfig()` re-applies live when the operator
 * edits the settings via the UI. Env vars stay as fallback so existing
 * deploys don't break.
 *
 * Spec: `docs/indexer-enrichment.md` §4.2 (boot health check), §6 (wiring).
 */

import { child as childLogger } from "../log.ts";
import {
  CircuitBreaker,
  type CircuitBreakerConfig,
} from "./circuit-breaker.ts";
import { CoordinateCache } from "./coordinate-cache.ts";
import {
  GEOCODE_HANDLER_VERSION,
  GeocodeWorker,
} from "./geocode-worker.ts";
import { NominatimClient } from "./nominatim-client.ts";
import {
  loadEnrichmentConfig,
  resolveEnrichmentConfig,
  type ResolvedEnrichmentConfig,
} from "./enrichment-config.repo.ts";

const log = childLogger("geocode");

let singleton: GeocodeWorker | null = null;
let breakerConfig: CircuitBreakerConfig | undefined = undefined;

export interface GeocodeBootstrapOptions {
  /** Override for tests. */
  breakerConfig?: CircuitBreakerConfig;
}

/**
 * Build the worker, run the Nominatim health check, and start the loop.
 *
 * Reads the resolved config (DB → env → defaults). Throws on health-check
 * failure. Returns `null` (without starting anything) when the worker is
 * disabled or the URL is unset. The caller should treat a thrown error as
 * fatal at boot time.
 */
export async function startGeocodeWorker(
  opts: GeocodeBootstrapOptions = {},
): Promise<GeocodeWorker | null> {
  breakerConfig = opts.breakerConfig;
  const dbConfig = await loadEnrichmentConfig();
  const resolved = resolveEnrichmentConfig(dbConfig);
  await applyResolved(resolved);
  return singleton;
}

/**
 * Re-apply settings after the operator changes them via the UI. The function
 * compares the new config against the running worker and:
 *   - stops the worker when enabled flips false or the URL is cleared
 *   - starts a fresh worker when enabled flips true and a URL is present
 *   - restarts when the URL changes (the cache + breaker state are scoped
 *     to the worker instance, so a fresh URL gets a fresh breaker)
 *
 * Throws if the new URL fails the health check; the caller should surface
 * that error and leave the previous worker running.
 */
export async function applyEnrichmentConfig(
  resolved: ResolvedEnrichmentConfig,
): Promise<void> {
  await applyResolved(resolved);
}

/** Graceful shutdown — called from the SIGTERM handler. */
export async function stopGeocodeWorker(): Promise<void> {
  if (!singleton) return;
  log.info("worker stopping");
  await singleton.shutdown();
  singleton = null;
  log.info("worker stopped");
}

/** Internal: shared boot + reapply path. */
async function applyResolved(
  resolved: ResolvedEnrichmentConfig,
): Promise<void> {
  const desiredEnabled = resolved.geocode_worker_enabled && !!resolved.nominatim_url;

  if (!desiredEnabled) {
    if (singleton) {
      log.info(
        { reason: !resolved.geocode_worker_enabled ? "disabled" : "no-url" },
        "stopping worker after config change",
      );
      await singleton.shutdown();
      singleton = null;
    } else if (!resolved.geocode_worker_enabled) {
      log.info("worker disabled (geocode_worker_enabled=false)");
    } else {
      log.info("MAPLE_NOMINATIM_URL unset — geocode worker not started");
    }
    return;
  }

  // Health check first. If the new URL is unreachable, leave any existing
  // worker running so a typo in the UI doesn't take down working geocoding.
  const url = resolved.nominatim_url!;
  const rateLimitPerSec = resolved.nominatim_rate_limit_per_sec;
  const client = new NominatimClient({ baseUrl: url, rateLimitPerSec });
  log.info({ url, rateLimitPerSec }, "checking Nominatim status");
  await client.health();
  log.info({ url, rateLimitPerSec }, "Nominatim healthy");

  // Replace the running worker only after the new client passes health.
  if (singleton) {
    log.info({ url }, "restarting worker for updated config");
    await singleton.shutdown();
    singleton = null;
  }

  const cache = new CoordinateCache({ geocoderVersion: GEOCODE_HANDLER_VERSION });
  const breaker = new CircuitBreaker(breakerConfig);
  const worker = new GeocodeWorker({ client, cache, breaker });
  worker.start();
  singleton = worker;
  log.info("worker started");
}

/** Test-only: peek at the singleton without spawning one. */
export function _getWorkerForTests(): GeocodeWorker | null {
  return singleton;
}
