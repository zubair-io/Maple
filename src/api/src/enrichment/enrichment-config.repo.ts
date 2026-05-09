/**
 * Persisted enrichment runtime config. Mirrors the `indexer-config` shape:
 * a single document in `app_settings` keyed by `_id: "enrichment"`.
 *
 * The values here override the env vars (`MAPLE_NOMINATIM_URL`,
 * `MAPLE_GEOCODE_WORKER_ENABLED`) at boot — env vars stay as a fallback so
 * existing deployments don't break when no row has been written yet.
 */

import { getDb } from "../db/client.ts";

const COLL = "app_settings";
const DOC_ID = "enrichment";

export interface EnrichmentConfig {
  nominatim_url: string | null;
  geocode_worker_enabled: boolean;
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
  /** Where each field came from. The UI renders this so the operator knows
   * whether they're seeing a saved value or an env-var fallback. */
  source: {
    nominatim_url: "db" | "env" | "unset";
    geocode_worker_enabled: "db" | "env" | "default";
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

  return {
    nominatim_url: url,
    geocode_worker_enabled: enabled,
    source: { nominatim_url: urlSource, geocode_worker_enabled: enabledSource },
  };
}
