/**
 * Persisted enrichment runtime config. Mirrors the `indexer-config` shape:
 * a single document in `app_settings` keyed by `_id: "enrichment"`.
 *
 * The values here override the env vars (`MAPLE_NOMINATIM_URL`,
 * `MAPLE_GEOCODE_WORKER_ENABLED`, `MAPLE_NOMINATIM_RATE_LIMIT_PER_SEC`) at
 * boot — env vars stay as a fallback so existing deployments don't break
 * when no row has been written yet.
 */

import { getDb } from "../db/client.ts";

const COLL = "app_settings";
const DOC_ID = "enrichment";

/** Default sustained Nominatim rate when no DB row and no env var is set.
 * Matches `nominatim-client.ts:DEFAULT_RATE_LIMIT` so behaviour is identical
 * before and after the operator-configurable surface lands. */
export const DEFAULT_NOMINATIM_RATE_LIMIT_PER_SEC = 10;

/** Reject obviously broken values up-front. The lower bound is non-zero so
 * a misclick can't pause the worker silently; the upper bound is generous
 * enough to drive a high-end Nominatim deployment but tight enough to flag
 * an accidental three-digit input. */
export const MIN_NOMINATIM_RATE_LIMIT_PER_SEC = 0.1;
export const MAX_NOMINATIM_RATE_LIMIT_PER_SEC = 100;

export interface EnrichmentConfig {
  nominatim_url: string | null;
  geocode_worker_enabled: boolean;
  /** Sustained Nominatim throttle (token-bucket refill rate). Per-process.
   * `null` when the operator hasn't saved an explicit value yet — the
   * resolver then falls back to env / default. */
  nominatim_rate_limit_per_sec?: number | null;
  updated_at?: number;
}

interface EnrichmentConfigDoc {
  _id: string;
  config: EnrichmentConfig;
}

/** Read the persisted config. Returns `null` when no row exists yet (first
 * boot of a fresh database). The caller should fall back to env vars. */
export async function loadEnrichmentConfig(): Promise<EnrichmentConfig | null> {
  try {
    const db = await getDb();
    const doc = await db
      .collection<EnrichmentConfigDoc>(COLL)
      .findOne({ _id: DOC_ID });
    return doc?.config ?? null;
  } catch {
    return null;
  }
}

/** Upsert. Partial patches are supported: only the fields you supply are
 * touched, the rest of the config doc is preserved. */
export async function saveEnrichmentConfig(
  patch: Partial<EnrichmentConfig>,
): Promise<void> {
  const db = await getDb();
  const set: Record<string, unknown> = {
    "config.updated_at": Date.now(),
  };
  if (patch.nominatim_url !== undefined) {
    set["config.nominatim_url"] = patch.nominatim_url;
  }
  if (patch.geocode_worker_enabled !== undefined) {
    set["config.geocode_worker_enabled"] = patch.geocode_worker_enabled;
  }
  if (patch.nominatim_rate_limit_per_sec !== undefined) {
    set["config.nominatim_rate_limit_per_sec"] =
      patch.nominatim_rate_limit_per_sec;
  }
  await db
    .collection(COLL)
    .updateOne({ _id: DOC_ID }, { $set: set }, { upsert: true });
}

/**
 * Resolve the effective config: DB row wins; missing fields fall back to env
 * vars; missing env vars fall back to defaults (no URL → worker dormant;
 * enabled defaults true). Pure function — no side effects, easy to test.
 */
export interface ResolvedEnrichmentConfig {
  nominatim_url: string | null;
  geocode_worker_enabled: boolean;
  nominatim_rate_limit_per_sec: number;
  /** Where each field came from. The UI renders this so the operator knows
   * whether they're seeing a saved value or an env-var fallback. */
  source: {
    nominatim_url: "db" | "env" | "unset";
    geocode_worker_enabled: "db" | "env" | "default";
    nominatim_rate_limit_per_sec: "db" | "env" | "default";
  };
}

export function resolveEnrichmentConfig(
  db: EnrichmentConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedEnrichmentConfig {
  let url: string | null = null;
  let urlSource: ResolvedEnrichmentConfig["source"]["nominatim_url"] = "unset";
  if (db && db.nominatim_url !== null && db.nominatim_url !== undefined) {
    url = db.nominatim_url;
    urlSource = "db";
  } else if (env.MAPLE_NOMINATIM_URL && env.MAPLE_NOMINATIM_URL.length > 0) {
    url = env.MAPLE_NOMINATIM_URL;
    urlSource = "env";
  }

  let enabled = true;
  let enabledSource: ResolvedEnrichmentConfig["source"]["geocode_worker_enabled"] =
    "default";
  if (db && typeof db.geocode_worker_enabled === "boolean") {
    enabled = db.geocode_worker_enabled;
    enabledSource = "db";
  } else if (env.MAPLE_GEOCODE_WORKER_ENABLED !== undefined) {
    enabled = env.MAPLE_GEOCODE_WORKER_ENABLED !== "false";
    enabledSource = "env";
  }

  let rateLimit = DEFAULT_NOMINATIM_RATE_LIMIT_PER_SEC;
  let rateSource: ResolvedEnrichmentConfig["source"]["nominatim_rate_limit_per_sec"] =
    "default";
  if (
    db &&
    typeof db.nominatim_rate_limit_per_sec === "number" &&
    Number.isFinite(db.nominatim_rate_limit_per_sec) &&
    db.nominatim_rate_limit_per_sec > 0
  ) {
    rateLimit = db.nominatim_rate_limit_per_sec;
    rateSource = "db";
  } else if (env.MAPLE_NOMINATIM_RATE_LIMIT_PER_SEC) {
    const parsed = Number(env.MAPLE_NOMINATIM_RATE_LIMIT_PER_SEC);
    if (Number.isFinite(parsed) && parsed > 0) {
      rateLimit = parsed;
      rateSource = "env";
    }
  }

  return {
    nominatim_url: url,
    geocode_worker_enabled: enabled,
    nominatim_rate_limit_per_sec: rateLimit,
    source: {
      nominatim_url: urlSource,
      geocode_worker_enabled: enabledSource,
      nominatim_rate_limit_per_sec: rateSource,
    },
  };
}
