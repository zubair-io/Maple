/**
 * Persisted Cloudflare R2 thumbnail-mirror config. A single document in
 * `app_settings` keyed by `_id: "cloudflare"`, mirroring the shape used by
 * `enrichment-config.repo.ts`.
 *
 * Unlike the enrichment config, there is no env-var fallback: R2
 * credentials are operator-entered exclusively through
 * `PUT /api/cloudflare/config` (per CLAUDE.md, settings belong in the
 * DB-backed settings system, not new env vars). `secret_access_key` is
 * stored in plaintext at rest, matching the existing
 * `meilisearch_api_key` precedent — never introduce new at-rest
 * encryption piecemeal per-feature.
 */

import { getDb } from '../db/client.ts';
import type { ResolvedCloudflareConfig } from './r2-client.ts';

const COLL = 'app_settings';
const DOC_ID = 'cloudflare';

export interface CloudflareConfig {
  enabled: boolean;
  account_id: string | null;
  bucket: string | null;
  access_key_id: string | null;
  /** Secret. Persisted but never echoed back over HTTP — routes report only
   * whether a key is set (see `toPublicConfig` in `routes/cloudflare.ts`). */
  secret_access_key: string | null;
  updated_at?: number;
}

interface CloudflareConfigDoc {
  _id: string;
  config: CloudflareConfig;
}

const DEFAULT_CONFIG: CloudflareConfig = {
  enabled: false,
  account_id: null,
  bucket: null,
  access_key_id: null,
  secret_access_key: null,
};

/** Read the persisted config. Returns `null` when no row exists yet. */
export async function loadCloudflareConfig(): Promise<CloudflareConfig | null> {
  try {
    const db = await getDb();
    const doc = await db.collection<CloudflareConfigDoc>(COLL).findOne({ _id: DOC_ID });
    return doc?.config ?? null;
  } catch {
    return null;
  }
}

/** Upsert. Partial patches are supported: only supplied fields are
 * touched. `secret_access_key: undefined` (field omitted from the patch)
 * leaves the existing value alone — the route layer is responsible for
 * translating "blank field in the UI" into "omit the key", never into an
 * explicit empty-string overwrite. */
export async function saveCloudflareConfig(patch: Partial<CloudflareConfig>): Promise<void> {
  const db = await getDb();
  const set: Record<string, unknown> = {
    'config.updated_at': Date.now(),
  };
  if (patch.enabled !== undefined) set['config.enabled'] = patch.enabled;
  if (patch.account_id !== undefined) set['config.account_id'] = patch.account_id;
  if (patch.bucket !== undefined) set['config.bucket'] = patch.bucket;
  if (patch.access_key_id !== undefined) set['config.access_key_id'] = patch.access_key_id;
  if (patch.secret_access_key !== undefined) {
    set['config.secret_access_key'] = patch.secret_access_key;
  }
  await db
    .collection<CloudflareConfigDoc>(COLL)
    .updateOne({ _id: DOC_ID }, { $set: set }, { upsert: true });
}

/** Resolve the effective config, filling in defaults for a first-boot
 * (no-row-yet) database. Pure function of the DB doc — no env fallback. */
export function resolveCloudflareConfig(db: CloudflareConfig | null): CloudflareConfig {
  return db ? { ...DEFAULT_CONFIG, ...db } : DEFAULT_CONFIG;
}

/** True when every field required to actually talk to R2 is present.
 * `enabled` alone isn't enough — an operator can flip the toggle before
 * filling in credentials, and callers (the indexer hook, the backfill job)
 * must treat that as "not ready" rather than throwing. */
export function isCloudflareConfigComplete(
  config: CloudflareConfig,
): config is CloudflareConfig & ResolvedCloudflareConfig {
  return (
    config.enabled &&
    !!config.account_id &&
    !!config.bucket &&
    !!config.access_key_id &&
    !!config.secret_access_key
  );
}

/** Strip the secret before it goes over HTTP, replacing it with a boolean
 * "is a key set" indicator — mirrors `toPublicConfig` in
 * `routes/enrichment.ts`. */
export function toPublicCloudflareConfig(config: CloudflareConfig) {
  const { secret_access_key, ...safe } = config;
  return {
    ...safe,
    secret_access_key_set: typeof secret_access_key === 'string' && secret_access_key.length > 0,
  };
}
