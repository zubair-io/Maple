/**
 * Persisted missing-reaper config. Mirrors the enrichment-config shape: a
 * single document in `app_settings` keyed by `_id: "missing-reaper"`.
 *
 * Only one knob today: `prune_window_hours` — how long an asset's original must
 * have been missing (`missing_since`) before the reaper will hard-delete the
 * row. Recovery/prune of a re-found file is never gated by this.
 *
 * Resolution order: DB doc → `MAPLE_REAPER_PRUNE_HOURS` env → default (12h). The
 * env stays a fallback so existing deployments behave before any row is written.
 */

import { getDb } from '../db/client.ts';
import { child as childLogger } from '../log.ts';

const COLL = 'app_settings';
const DOC_ID = 'missing-reaper';
const log = childLogger('missing-reaper:config');

/** Default window if neither a DB row nor the env var is set. */
export const DEFAULT_PRUNE_WINDOW_HOURS = 12;
/** Clamp bounds — a window of 0 would delete on first detection (unsafe); an
 * absurdly large one is almost certainly a typo. */
const MIN_PRUNE_WINDOW_HOURS = 1;
const MAX_PRUNE_WINDOW_HOURS = 24 * 365;

function clampHours(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_PRUNE_WINDOW_HOURS;
  return Math.min(MAX_PRUNE_WINDOW_HOURS, Math.max(MIN_PRUNE_WINDOW_HOURS, Math.round(n)));
}

function envHours(): number | null {
  const raw = process.env.MAPLE_REAPER_PRUNE_HOURS;
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? clampHours(n) : null;
}

/** Resolve the effective prune window in hours. */
export async function loadPruneWindowHours(): Promise<number> {
  try {
    const db = await getDb();
    const doc = await db
      .collection<{ _id: string; prune_window_hours?: number }>(COLL)
      .findOne({ _id: DOC_ID });
    if (doc && typeof doc.prune_window_hours === 'number') {
      return clampHours(doc.prune_window_hours);
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      'could not load prune window from app_settings — falling back to env/default',
    );
  }
  return envHours() ?? DEFAULT_PRUNE_WINDOW_HOURS;
}

/** Persist the prune window (operator edit via /api/workers/missing-reaper/config).
 * Returns the clamped value that was stored. */
export async function savePruneWindowHours(hours: number): Promise<number> {
  const clamped = clampHours(hours);
  const db = await getDb();
  await db
    .collection<{ _id: string; prune_window_hours?: number }>(COLL)
    .updateOne({ _id: DOC_ID }, { $set: { prune_window_hours: clamped } }, { upsert: true });
  return clamped;
}
