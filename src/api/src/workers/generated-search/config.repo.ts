/**
 * Persisted generated-search worker config. A single `app_settings` document
 * keyed `_id: "generated_search"`, mirroring `dedupe-config.repo.ts`.
 *
 * DB-backed rather than env vars, per the CLAUDE.md "configure via the
 * settings system" rule — every knob is operator-editable at runtime from
 * Settings → Workers and re-read on the next tick, so a change takes effect
 * with no restart and no shell access:
 *
 *   - `collections_per_day` — how many collections to aim for each run.
 *   - `min_results`         — fewest photos a collection may contain and
 *                             still be kept. A cheap filter for empty
 *                             queries; the real quality gates are structural
 *                             (see `loop.ts`).
 *   - `max_rounds`          — proposal rounds before the run gives up and
 *                             saves whatever cleared the floor.
 *   - `model`               — which Ollama model proposes and titles.
 *   - `dry_run`             — run the whole loop and log what it WOULD save
 *                             without writing. Lets an operator evaluate a
 *                             prompt change against the real library.
 *
 * Starts PAUSED. The worker depends on Ollama being configured and reachable,
 * and a paused start means a fresh install does not quietly produce garbage
 * collections before an operator has looked at it — the same reasoning behind
 * `geocode`'s `pausedOnFirstBoot` and the missing-reaper's paused default.
 */

import { getDb } from '../../db/client.ts';
import { child as childLogger } from '../../log.ts';

const COLL = 'app_settings';
const DOC_ID = 'generated_search';
const log = childLogger('generated-search:config');

export const DEFAULT_COLLECTIONS_PER_DAY = 4;
export const DEFAULT_MIN_RESULTS = 8;
export const DEFAULT_MAX_ROUNDS = 3;
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_PAUSED = true;
export const DEFAULT_DRY_RUN = false;

const LIMITS = {
  collections_per_day: { min: 1, max: 12, fallback: DEFAULT_COLLECTIONS_PER_DAY },
  min_results: { min: 1, max: 1000, fallback: DEFAULT_MIN_RESULTS },
  max_rounds: { min: 1, max: 10, fallback: DEFAULT_MAX_ROUNDS },
  retention_days: { min: 1, max: 365, fallback: DEFAULT_RETENTION_DAYS },
} as const;

export type NumericKnob = keyof typeof LIMITS;

export interface GeneratedSearchConfig {
  collections_per_day: number;
  min_results: number;
  max_rounds: number;
  retention_days: number;
  /** Empty string means "use the describe stage's configured model". */
  model: string;
  paused: boolean;
  dry_run: boolean;
}

interface ConfigDoc extends Partial<GeneratedSearchConfig> {
  _id: string;
}

/** Clamp a knob into its safe range. A non-finite value falls back to the
 * default rather than throwing — an operator typo must not wedge the worker. */
export function clampKnob(knob: NumericKnob, value: number): number {
  const { min, max, fallback } = LIMITS[knob];
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readNumber(knob: NumericKnob, raw: unknown): number {
  return typeof raw === 'number' ? clampKnob(knob, raw) : LIMITS[knob].fallback;
}

/** Resolve the effective config. Missing doc / missing fields → defaults. */
export async function loadGeneratedSearchConfig(): Promise<GeneratedSearchConfig> {
  try {
    const db = await getDb();
    const doc = await db.collection<ConfigDoc>(COLL).findOne({ _id: DOC_ID });
    return {
      collections_per_day: readNumber('collections_per_day', doc?.collections_per_day),
      min_results: readNumber('min_results', doc?.min_results),
      max_rounds: readNumber('max_rounds', doc?.max_rounds),
      retention_days: readNumber('retention_days', doc?.retention_days),
      model: typeof doc?.model === 'string' ? doc.model : '',
      paused: typeof doc?.paused === 'boolean' ? doc.paused : DEFAULT_PAUSED,
      dry_run: typeof doc?.dry_run === 'boolean' ? doc.dry_run : DEFAULT_DRY_RUN,
    };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      'could not load generated-search config — using defaults',
    );
    return {
      collections_per_day: DEFAULT_COLLECTIONS_PER_DAY,
      min_results: DEFAULT_MIN_RESULTS,
      max_rounds: DEFAULT_MAX_ROUNDS,
      retention_days: DEFAULT_RETENTION_DAYS,
      model: '',
      paused: DEFAULT_PAUSED,
      dry_run: DEFAULT_DRY_RUN,
    };
  }
}

/** Persist a partial config edit (operator PATCH). Returns the stored config. */
export async function saveGeneratedSearchConfig(
  patch: Partial<GeneratedSearchConfig>,
): Promise<GeneratedSearchConfig> {
  const set: Partial<ConfigDoc> = {};
  for (const knob of Object.keys(LIMITS) as NumericKnob[]) {
    const value = patch[knob];
    if (typeof value === 'number') set[knob] = clampKnob(knob, value);
  }
  if (typeof patch.model === 'string') set.model = patch.model;
  if (typeof patch.paused === 'boolean') set.paused = patch.paused;
  if (typeof patch.dry_run === 'boolean') set.dry_run = patch.dry_run;

  if (Object.keys(set).length > 0) {
    const db = await getDb();
    await db
      .collection<ConfigDoc>(COLL)
      .updateOne({ _id: DOC_ID }, { $set: set }, { upsert: true });
  }
  return loadGeneratedSearchConfig();
}
