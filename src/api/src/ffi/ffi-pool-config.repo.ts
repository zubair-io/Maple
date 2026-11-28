/**
 * Persisted FFI decode-pool config. Mirrors the enrichment-config shape: a
 * single row in `app_settings` keyed `id = 'performance'`, holding
 * `ffi_workers` and `decode_memory_budget_percent` (#5467).
 *
 * Precedence (resolveFfiPoolConfig): DB row > env var (`MAPLE_FFI_WORKERS`) >
 * built-in default (2, or 1 when the decode memory budget is 0).
 *
 * The value is hard-clamped to [MIN_FFI_WORKERS, MAX_FFI_WORKERS] at resolve
 * time so a hand-edited DB row or env var can never spawn an unbounded number
 * of dylib-loaded worker threads.
 */

import {
  patchAppSettings,
  readAppSettings,
  type SettingsValue,
} from '../db/repos/app-settings.repo.ts';

const DOC_ID = 'performance';

/** Built-in default when neither a DB row nor the env var is set. Two cut the
 * median cold-folder thumbnail wait from 1.4 s to 0.85 s on unedited RAWs and
 * from 21–25 s to 17 s on edited ones, where two develops at once raised peak
 * memory by 1.5–2.8 GB (#6195). The decode memory budget is what bounds that,
 * so with a budget of 0 (no cap) the default is `UNCAPPED_DEFAULT_FFI_WORKERS`. */
export const DEFAULT_FFI_WORKERS = 2;
export const UNCAPPED_DEFAULT_FFI_WORKERS = 1;

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

/**
 * Share of the container memory limit that native decodes and panorama
 * stitches may reserve (#5467). The rest is headroom for what the budget does
 * not meter: the API and worker processes, the search child (~4 GB with its
 * model), the API's own on-demand decode child, the bitmap-lane child (raw-core
 * caps its decode at 2 GiB) and the freed-but-mapped heap idle decode children
 * keep (0.4–1.3 GB each, measured on the 44 GB production container). 50% of
 * that container is 22 GiB: three concurrent 50 MP develops, or sixteen
 * extractions. 0 removes the cap.
 */
export const DEFAULT_DECODE_MEMORY_BUDGET_PERCENT = 50;
export const MIN_DECODE_MEMORY_BUDGET_PERCENT = 0;
export const MAX_DECODE_MEMORY_BUDGET_PERCENT = 90;

export function clampDecodeMemoryBudgetPercent(raw: number): number | null {
  if (!Number.isFinite(raw)) return null;
  return Math.max(
    MIN_DECODE_MEMORY_BUDGET_PERCENT,
    Math.min(MAX_DECODE_MEMORY_BUDGET_PERCENT, Math.floor(raw)),
  );
}

export interface PerformanceConfig {
  /** Operator-saved FFI decode-pool size. `null`/missing → resolver falls
   * back to env / default. */
  ffi_workers?: number | null;
  decode_memory_budget_percent?: number | null;
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
  return readPerformanceConfig().catch(() => null);
}

/** Like `loadPerformanceConfig`, but a DB failure throws instead of reading as
 * "no row", so a periodic re-apply never mistakes an outage for defaults. */
export async function readPerformanceConfig(): Promise<PerformanceConfig | null> {
  const doc = await readAppSettings<PerformanceConfigDoc>(DOC_ID);
  return doc?.config ?? null;
}

/** Upsert. Partial patches supported: only supplied fields are touched. */
export async function savePerformanceConfig(patch: Partial<PerformanceConfig>): Promise<void> {
  const set: Record<string, SettingsValue | undefined> = {
    'config.updated_at': Date.now(),
  };
  if (patch.ffi_workers !== undefined) {
    set['config.ffi_workers'] = patch.ffi_workers;
  }
  if (patch.decode_memory_budget_percent !== undefined) {
    set['config.decode_memory_budget_percent'] = patch.decode_memory_budget_percent;
  }
  await patchAppSettings(DOC_ID, set);
}

export interface ResolvedPerformanceConfig {
  /** Effective, hard-clamped pool size. Always in [MIN, MAX]. */
  ffi_workers: number;
  /** Effective, clamped budget share; 0 = no cap. */
  decode_memory_budget_percent: number;
  source: {
    ffi_workers: 'db' | 'env' | 'default';
    decode_memory_budget_percent: 'db' | 'default';
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
  const savedPercent =
    typeof db?.decode_memory_budget_percent === 'number'
      ? clampDecodeMemoryBudgetPercent(db.decode_memory_budget_percent)
      : null;
  const budgetPercent = savedPercent ?? DEFAULT_DECODE_MEMORY_BUDGET_PERCENT;
  const workers = resolveWorkers(db, env, budgetPercent);

  return {
    ffi_workers: workers.value,
    decode_memory_budget_percent: budgetPercent,
    source: {
      ffi_workers: workers.source,
      decode_memory_budget_percent: savedPercent === null ? 'default' : 'db',
    },
  };
}

function resolveWorkers(
  db: PerformanceConfig | null,
  env: NodeJS.ProcessEnv,
  budgetPercent: number,
): { value: number; source: ResolvedPerformanceConfig['source']['ffi_workers'] } {
  const saved = typeof db?.ffi_workers === 'number' ? clampFfiWorkers(db.ffi_workers) : null;
  if (saved !== null) return { value: saved, source: 'db' };
  const fromEnv =
    typeof db?.ffi_workers !== 'number' && env.MAPLE_FFI_WORKERS
      ? clampFfiWorkers(Number(env.MAPLE_FFI_WORKERS))
      : null;
  if (fromEnv !== null) return { value: fromEnv, source: 'env' };
  return {
    value: budgetPercent === 0 ? UNCAPPED_DEFAULT_FFI_WORKERS : DEFAULT_FFI_WORKERS,
    source: 'default',
  };
}
