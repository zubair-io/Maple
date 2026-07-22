/**
 * Persisted config for the derivative-audit worker. A single document in
 * `app_settings` keyed `_id: "derivative-audit"`, mirroring the shape of
 * `cloudflare-config.repo.ts`. Operator-editable at runtime (Settings →
 * Workers), never an env var (CLAUDE.md).
 */
import { getDb } from '../../db/client.ts';

const COLL = 'app_settings';
const DOC_ID = 'derivative-audit';

export interface DerivativeAuditConfig {
  /** Master toggle for the interval loop. */
  enabled: boolean;
  /** Loop cadence in ms. Default 6h — a full-library disk+R2 sweep is cheap
   * per asset but there is no urgency, and a long cadence keeps R2 HEAD
   * volume modest. */
  interval_ms: number;
  /** Runaway guard: stop issuing stage resets after this many in one pass so a
   * mass-drift event can't flood the downstream pipeline. */
  max_resets_per_pass: number;
  /** How many assets are evaluated concurrently (bounds parallel R2 HEADs). */
  concurrency: number;
  /** Whether to HEAD each thumbnail's R2 object to detect bucket-side drift.
   * Auto-skipped when Cloudflare is not fully configured, regardless of this. */
  deep_r2_enabled: boolean;
  updated_at?: number;
}

interface DerivativeAuditConfigDoc {
  _id: string;
  config: DerivativeAuditConfig;
}

export const DEFAULT_DERIVATIVE_AUDIT_CONFIG: DerivativeAuditConfig = {
  enabled: true,
  interval_ms: 21_600_000,
  max_resets_per_pass: 500,
  concurrency: 8,
  deep_r2_enabled: true,
};

/** Read the effective config, merged over defaults. Returns defaults on any
 * read error (mirrors `loadCloudflareConfig`'s swallow-and-default). */
export async function loadDerivativeAuditConfig(): Promise<DerivativeAuditConfig> {
  try {
    const db = await getDb();
    const doc = await db.collection<DerivativeAuditConfigDoc>(COLL).findOne({ _id: DOC_ID });
    return { ...DEFAULT_DERIVATIVE_AUDIT_CONFIG, ...(doc?.config ?? {}) };
  } catch {
    return { ...DEFAULT_DERIVATIVE_AUDIT_CONFIG };
  }
}

/** Upsert. Only supplied fields are touched; `updated_at` is always stamped. */
export async function saveDerivativeAuditConfig(
  patch: Partial<DerivativeAuditConfig>,
): Promise<void> {
  const db = await getDb();
  const set: Record<string, unknown> = { 'config.updated_at': Date.now() };
  for (const k of [
    'enabled',
    'interval_ms',
    'max_resets_per_pass',
    'concurrency',
    'deep_r2_enabled',
  ] as const) {
    if (patch[k] !== undefined) set[`config.${k}`] = patch[k];
  }
  await db
    .collection<DerivativeAuditConfigDoc>(COLL)
    .updateOne({ _id: DOC_ID }, { $set: set }, { upsert: true });
}
