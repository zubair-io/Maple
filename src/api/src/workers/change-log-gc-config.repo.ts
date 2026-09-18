/**
 * Persisted config + last-pass readout for the `change-log-gc` maintenance job.
 *
 * Stored in `worker_config` keyed `name: "change-log-gc"` — the same collection
 * every other worker's operator-editable state lives in, so the retention
 * window is adjustable at runtime from Settings → Workers with no restart and
 * no new environment variable (CLAUDE.md § "Configure via the settings system,
 * not new env vars").
 *
 * The worker tier runs in a child process (`worker-main.ts`), so the last-pass
 * summary is persisted here rather than held in module state: the API process
 * that serves the settings page cannot read the worker process's memory.
 *
 * Only this repo touches the `enabled` / `retention_days` / `last_run` fields.
 * `WorkerConfigRepo` writes `paused` and the stage knobs on its own docs and
 * `$set`s field-by-field, so the two never clobber each other.
 */

import { getDb } from '../db/client.ts';
import { child as childLogger } from '../log.ts';

const COLL = 'worker_config';
const WORKER_NAME = 'change-log-gc';
const log = childLogger('change-log-gc:config');

/** Matches trash-gc's retention window — the other retention-driven sweep. */
export const DEFAULT_RETENTION_DAYS = 30;
/** A window of 0 would delete rows a live client is still catching up on. */
const MIN_RETENTION_DAYS = 1;
/** Ten years — past this the value is a typo, not an intent. */
const MAX_RETENTION_DAYS = 3650;

/** Summary of the most recent sweep, shown on the Workers settings page. */
export interface ChangeLogGcRun {
  /** Rows removed by the pass. */
  deleted: number;
  /** Delete batches issued — the event-loop yield count. */
  batches: number;
  duration_ms: number;
  /** Highest `cursor` value the pass removed; 0 when it removed nothing. */
  pruned_through: number;
  /** Rows left in `asset_changes` afterwards (collection metadata, not a scan). */
  remaining: number;
  finished_at: string;
  /** Present only when the pass ended on an error. */
  error?: string;
}

export interface ChangeLogGcConfig {
  enabled: boolean;
  retention_days: number;
  last_run: ChangeLogGcRun | null;
}

interface ChangeLogGcConfigDoc {
  name: string;
  enabled?: boolean;
  retention_days?: number;
  last_run?: ChangeLogGcRun | null;
}

export const DEFAULT_CHANGE_LOG_GC_CONFIG: ChangeLogGcConfig = {
  enabled: true,
  retention_days: DEFAULT_RETENTION_DAYS,
  last_run: null,
};

/** Clamp a requested window into the safe range; a non-finite value falls back
 * to the default rather than throwing. */
export function clampRetentionDays(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_RETENTION_DAYS;
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.round(n)));
}

/** Resolve the effective config. Missing doc / missing fields / read failure
 * all fall back to defaults, so a config-store blip never changes behaviour. */
export async function loadChangeLogGcConfig(): Promise<ChangeLogGcConfig> {
  try {
    const db = await getDb();
    const doc = await db.collection<ChangeLogGcConfigDoc>(COLL).findOne({ name: WORKER_NAME });
    return {
      enabled:
        typeof doc?.enabled === 'boolean' ? doc.enabled : DEFAULT_CHANGE_LOG_GC_CONFIG.enabled,
      retention_days:
        typeof doc?.retention_days === 'number'
          ? clampRetentionDays(doc.retention_days)
          : DEFAULT_RETENTION_DAYS,
      last_run: doc?.last_run ?? null,
    };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      'could not load change-log-gc config from worker_config — using defaults',
    );
    return { ...DEFAULT_CHANGE_LOG_GC_CONFIG };
  }
}

/** Persist an operator edit. Returns the config as stored (clamped). */
export async function saveChangeLogGcConfig(
  patch: Partial<Pick<ChangeLogGcConfig, 'enabled' | 'retention_days'>>,
): Promise<ChangeLogGcConfig> {
  const set: Partial<ChangeLogGcConfigDoc> = {};
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.retention_days !== undefined) {
    set.retention_days = clampRetentionDays(patch.retention_days);
  }
  const db = await getDb();
  await db
    .collection<ChangeLogGcConfigDoc>(COLL)
    .updateOne(
      { name: WORKER_NAME },
      { $set: set, $setOnInsert: { name: WORKER_NAME } },
      { upsert: true },
    );
  return loadChangeLogGcConfig();
}

/** Record the summary of a completed pass. Best-effort — a failure here must
 * not fail the sweep that just succeeded. */
export async function recordChangeLogGcRun(run: ChangeLogGcRun): Promise<void> {
  try {
    const db = await getDb();
    await db
      .collection<ChangeLogGcConfigDoc>(COLL)
      .updateOne(
        { name: WORKER_NAME },
        { $set: { last_run: run }, $setOnInsert: { name: WORKER_NAME } },
        { upsert: true },
      );
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : err }, 'could not record last run');
  }
}

export { WORKER_NAME as CHANGE_LOG_GC_NAME };
