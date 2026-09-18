/**
 * Persisted change-log-gc config. Mirrors the missing-reaper / dedupe config shape:
 * a single document in `app_settings` keyed by `_id: "change-log-gc"`.
 *
 * Primary knob: `retention_days` — how many days of asset change history to retain.
 * Changes older than `now - retention_days` are pruned in bounded batches.
 * Defaults to 30 days, matching `trash-gc`.
 *
 * DB-backed per the CLAUDE.md "configure via the settings system" rule — operator-tunable
 * from Settings → Workers, re-read each sweep tick so changes take effect without restart.
 */

import { getDb } from '../db/client.ts';
import { child as childLogger } from '../log.ts';

const COLL = 'app_settings';
const DOC_ID = 'change-log-gc';
const log = childLogger('change-log-gc:config');

export const DEFAULT_RETENTION_DAYS = 30;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650; // 10 years

export interface ChangeLogGcConfig {
  retention_days: number;
}

interface ChangeLogGcDoc {
  _id: string;
  retention_days?: number;
}

export function clampRetentionDays(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_RETENTION_DAYS;
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.round(n)));
}

/** Load effective retention days from app_settings (or default). */
export async function loadChangeLogRetentionDays(): Promise<number> {
  try {
    const db = await getDb();
    const doc = await db.collection<ChangeLogGcDoc>(COLL).findOne({ _id: DOC_ID });
    if (doc && typeof doc.retention_days === 'number') {
      return clampRetentionDays(doc.retention_days);
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      'could not load retention days from app_settings — falling back to default',
    );
  }
  return DEFAULT_RETENTION_DAYS;
}

/** Persist retention days. Returns the clamped value that was stored. */
export async function saveChangeLogRetentionDays(days: number): Promise<number> {
  const clamped = clampRetentionDays(days);
  const db = await getDb();
  await db
    .collection<ChangeLogGcDoc>(COLL)
    .updateOne({ _id: DOC_ID }, { $set: { retention_days: clamped } }, { upsert: true });
  return clamped;
}

/** Load full config document. */
export async function loadChangeLogGcConfig(): Promise<ChangeLogGcConfig> {
  const retention_days = await loadChangeLogRetentionDays();
  return { retention_days };
}

/** Persist partial config patch. Returns updated config. */
export async function saveChangeLogGcConfig(
  patch: Partial<ChangeLogGcConfig>,
): Promise<ChangeLogGcConfig> {
  if (typeof patch.retention_days === 'number') {
    const days = await saveChangeLogRetentionDays(patch.retention_days);
    return { retention_days: days };
  }
  return loadChangeLogGcConfig();
}
