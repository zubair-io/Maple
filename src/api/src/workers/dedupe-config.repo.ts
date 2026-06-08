/**
 * Persisted DeDuplicate-worker config. A single `app_settings` document keyed
 * `_id: "deduplicate"`, mirroring `missing-reaper-config.repo.ts`.
 *
 * DB-backed (not env vars) per the CLAUDE.md "configure via the settings system"
 * rule — both knobs are operator-editable at runtime via
 * `PATCH /api/workers/deduplicate/config` and re-read on the next tick, so a
 * change takes effect with no restart:
 *
 *   - `batch_size` — assets examined per pass. Bounds how many duplicate files
 *     one pass can move (the per-pass blast radius).
 *   - `dry_run`    — when true the worker logs the moves it WOULD make and
 *     mutates nothing on disk or in Mongo. A safe preview before an operator
 *     resumes the (paused-by-default) worker.
 */

import { getDb } from '../db/client.ts';
import { child as childLogger } from '../log.ts';

const COLL = 'app_settings';
const DOC_ID = 'deduplicate';
const log = childLogger('deduplicate:config');

export const DEFAULT_BATCH_SIZE = 200;
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 5000;
export const DEFAULT_DRY_RUN = false;

export interface DeDuplicateConfig {
  batch_size: number;
  dry_run: boolean;
}

interface DeDuplicateConfigDoc {
  _id: string;
  batch_size?: number;
  dry_run?: boolean;
}

/** Clamp a requested batch size into the safe range. A non-finite value falls
 * back to the default rather than throwing. */
export function clampBatchSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_BATCH_SIZE;
  return Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, Math.round(n)));
}

/** Resolve the effective config. Missing doc / missing fields → defaults. */
export async function loadDeDuplicateConfig(): Promise<DeDuplicateConfig> {
  try {
    const db = await getDb();
    const doc = await db.collection<DeDuplicateConfigDoc>(COLL).findOne({ _id: DOC_ID });
    return {
      batch_size:
        typeof doc?.batch_size === 'number' ? clampBatchSize(doc.batch_size) : DEFAULT_BATCH_SIZE,
      dry_run: typeof doc?.dry_run === 'boolean' ? doc.dry_run : DEFAULT_DRY_RUN,
    };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      'could not load deduplicate config from app_settings — using defaults',
    );
    return { batch_size: DEFAULT_BATCH_SIZE, dry_run: DEFAULT_DRY_RUN };
  }
}

/** Persist a partial config edit (operator PATCH). Returns the stored config. */
export async function saveDeDuplicateConfig(
  patch: Partial<DeDuplicateConfig>,
): Promise<DeDuplicateConfig> {
  const set: Partial<DeDuplicateConfigDoc> = {};
  if (patch.batch_size !== undefined) set.batch_size = clampBatchSize(patch.batch_size);
  if (patch.dry_run !== undefined) set.dry_run = patch.dry_run;
  const db = await getDb();
  await db
    .collection<DeDuplicateConfigDoc>(COLL)
    .updateOne({ _id: DOC_ID }, { $set: set }, { upsert: true });
  return loadDeDuplicateConfig();
}
