/**
 * Persisted FFI decode-pool config. Mirrors the enrichment-config shape: a
 * single document in `app_settings` keyed by `_id: "performance"`, with one
 * field today — `ffi_workers`.
 *
 * Precedence (resolveFfiPoolConfig): DB row > env var (`MAPLE_FFI_WORKERS`) >
 * built-in default (1). Default 1 keeps the change pure opt-in: an upgraded
 * deploy with no saved row and no env var behaves exactly as before (one
 * in-flight native RAW decode, everything else queues).
 *
 * The value is hard-clamped to [MIN_FFI_WORKERS, MAX_FFI_WORKERS] at resolve
 * time so a hand-edited DB row or env var can never spawn an unbounded number
 * of dylib-loaded worker threads.
 */

import { getDb } from '../db/client.ts';

const COLL = 'app_settings';
const DOC_ID = 'performance';

/** Built-in default when neither a DB row nor the env var is set. One worker
 * = the historical single-decode-at-a-time behaviour (zero behaviour change
 * on upgrade). */
export const DEFAULT_FFI_WORKERS = 1;

/** Hard clamp. One native decode at minimum; 16 is a generous ceiling that
 * still bounds dylib loads + per-worker memory on tight Self Hosted boxes. */
export const MIN_FFI_WORKERS = 1;
export const MAX_FFI_WORKERS = 16;

/** Clamp an arbitrary number into [MIN, MAX], flooring fractions. Returns
 * `null` for non-finite input so callers can reject rather than silently
 * coerce a garbage value. */
export function clampFfiWorkers(raw: number): number | null {
  if (!Number.isFinite(raw)) return null;
  const floored = Math.floor(raw);
  return Math.max(MIN_FFI_WORKERS, Math.min(MAX_FFI_WORKERS, floored));
}

export interface PerformanceConfig {
  /** Operator-saved FFI decode-pool size. `null`/missing → resolver falls
   * back to env / default. */
  ffi_workers?: number | null;
  updated_at?: number;
}

interface PerformanceConfigDoc {
  _id: string;
  config: PerformanceConfig;
}

/** Read the persisted performance config. Returns `null` when no row exists
 * yet (fresh DB) or the DB is unreachable — the caller falls back to env /
 * default. */
export async function loadPerformanceConfig(): Promise<PerformanceConfig | null> {
  try {
    const db = await getDb();
    const doc = await db.collection<PerformanceConfigDoc>(COLL).findOne({ _id: DOC_ID });
    return doc?.config ?? null;
  } catch {
    return null;
  }
}

/** Upsert. Partial patches supported: only supplied fields are touched. */
export async function savePerformanceConfig(patch: Partial<PerformanceConfig>): Promise<void> {
  const db = await getDb();
  const set: Record<string, unknown> = {
    'config.updated_at': Date.now(),
  };
  if (patch.ffi_workers !== undefined) {
    set['config.ffi_workers'] = patch.ffi_workers;
  }
  await db.collection(COLL).updateOne({ _id: DOC_ID }, { $set: set }, { upsert: true });
}

export interface ResolvedPerformanceConfig {
  /** Effective, hard-clamped pool size. Always in [MIN, MAX]. */
  ffi_workers: number;
  source: {
    ffi_workers: 'db' | 'env' | 'default';
  };
}

/**
 * Resolve the effective performance config: DB row wins; missing falls back
 * to `MAPLE_FFI_WORKERS`; missing env falls back to the built-in default. The
 * resolved value is always clamped to [MIN, MAX]. Pure function — no side
 * effects, easy to test.
 */
export function resolveFfiPoolConfig(
  db: PerformanceConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPerformanceConfig {
  let workers = DEFAULT_FFI_WORKERS;
  let source: ResolvedPerformanceConfig['source']['ffi_workers'] = 'default';

  if (db && typeof db.ffi_workers === 'number') {
    const clamped = clampFfiWorkers(db.ffi_workers);
    if (clamped !== null) {
      workers = clamped;
      source = 'db';
    }
  } else if (env.MAPLE_FFI_WORKERS !== undefined && env.MAPLE_FFI_WORKERS.length > 0) {
    const clamped = clampFfiWorkers(Number(env.MAPLE_FFI_WORKERS));
    if (clamped !== null) {
      workers = clamped;
      source = 'env';
    }
  }

  return { ffi_workers: workers, source: { ffi_workers: source } };
}
