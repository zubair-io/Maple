/**
 * Keeping every page of one free-text search on one engine and one set of window depths (#4542).
 *
 * A search's first page is ranked by whichever engine answers (`requestWindow`). Its response
 * carries a `rankPin` — the engine, the ladder steps its window was ranked at, and a fingerprint
 * of the search — and the client sends that back with each further page. A pinned page is ranked
 * by that engine alone, replaying the same steps, so it continues the ranking earlier pages were
 * cut from. When the pinned engine cannot answer, or the pin belongs to a different search, the
 * page is not ranked some other way: the caller tells the client to restart from page 0, because
 * a different ranking's page N repeats rows already shown and skips others.
 *
 * Replaying steps matters for the in-process engine: its fused ranking at depth 400 does not keep
 * the order of its ranking at depth 100 (each leg contributes deeper hits to the fusion). So a
 * pinned window is the first step's rows, then each deeper step's rows not already in it — every
 * served page stays a prefix of the next page's window. The database's order is total, so its
 * deeper windows extend shallower ones and only its deepest step needs ranking.
 *
 * What is pinned is the engine and its depths, not a snapshot of the ranked ids: an index change
 * between two pages (a newly embedded photo, an edited caption) can still move rows, as it could
 * before. Facets and buckets keep counting the unpinned window of the same page.
 */

import { createHash } from 'node:crypto';
import {
  RANKED_WINDOW_MAX,
  windowDepthFor,
  type WindowPass,
  type WindowRow,
} from '../../db/repos/search.ranked.ts';
import {
  engineRanker,
  firstEngine,
  type EngineWindow,
  type WindowEngine,
  type WindowRequest,
} from './ranked-window.ts';

/** The engine a search's pages are ranked by, the ladder steps its window was built from, and
 * the search it was minted for. */
export interface RankPin {
  engine: WindowEngine;
  steps: readonly number[];
  search: string;
}

const FINGERPRINT = /^[A-Za-z0-9_-]{12}$/;
const STEPS = /^[1-9]\d*(,[1-9]\d*)*$/;

/** A short digest of the ranked text and every filter, so a pin cannot steer another search. */
function searchFingerprint(request: Pick<WindowRequest, 'where' | 'text'>): string {
  const canonical = JSON.stringify([request.text, request.where], (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 12);
}

export function encodeRankPin(pin: RankPin): string {
  return `${pin.engine}:${pin.steps.join(',')}:${pin.search}`;
}

/**
 * A pin from its wire form, or null when it is not one this server mints: a known engine, a
 * fingerprint, and steps that start on the ladder and climb it one step at a time.
 */
export function decodeRankPin(raw: string): RankPin | null {
  const [engine, steps, search, ...rest] = raw.split(':');
  const known = engine === 'in-process' || engine === 'database';
  if (!known || rest.length > 0 || !STEPS.test(steps ?? '') || !FINGERPRINT.test(search ?? '')) {
    return null;
  }
  const parsed = steps!.split(',').map(Number);
  const climbs = parsed.every((step, index) =>
    index === 0
      ? windowDepthFor(step) === step
      : parsed[index - 1]! < RANKED_WINDOW_MAX && step === windowDepthFor(parsed[index - 1]! + 1),
  );
  return climbs ? { engine, steps: parsed, search: search! } : null;
}

/** The pin of an unpinned request's window: the engine that answered and the step it served. */
export function pinOf(window: EngineWindow, request: WindowRequest): RankPin {
  return { engine: window.engine, steps: [window.depth], search: searchFingerprint(request) };
}

interface Merged {
  rows: WindowRow[];
  semantic: Set<string>;
  scores: Map<string, number>;
}

function merge(into: Merged, pass: WindowPass): Merged {
  const held = new Set(into.rows.map((row) => row.r));
  const scores = new Map(pass.scores ?? []);
  into.scores.forEach((score, id) => scores.set(id, score));
  return {
    rows: [...into.rows, ...pass.rows.filter((row) => !held.has(row.r))],
    semantic: new Set([...into.semantic, ...(pass.semantic ?? [])]),
    scores,
  };
}

/**
 * The window of a pinned page, or null when the pinned engine cannot rank it or the pin belongs to
 * another search. Replays the pin's steps one at a time — the child answers one query at a time
 * anyway — then widens up the ladder until the page's `need` is met, the engine runs out of hits,
 * or the cap is reached; `pin` is what the page's response carries.
 */
export async function pinnedWindow(
  request: WindowRequest,
  pin: RankPin,
): Promise<{ window: EngineWindow; pin: RankPin } | null> {
  if (pin.search !== searchFingerprint(request)) return null;
  const ranker = engineRanker(pin.engine, request);
  const empty: Merged = { rows: [], semantic: new Set(), scores: new Map() };

  const rank = async (
    merged: Merged,
    steps: readonly number[],
    pending: readonly number[],
  ): Promise<{ window: EngineWindow; pin: RankPin } | null> => {
    const [depth, ...rest] = pending;
    const pass = await ranker(depth!);
    if (pass === null) return null;
    const next = merge(merged, pass);
    if (rest.length > 0) return rank(next, steps, rest);
    const full = pass.considered >= depth!;
    if (next.rows.length < request.need && full && depth! < RANKED_WINDOW_MAX) {
      const deeper = windowDepthFor(depth! + 1);
      return rank(next, [...steps, deeper], [deeper]);
    }
    const atCap = depth! >= RANKED_WINDOW_MAX;
    return {
      window: {
        ...next,
        more: full && !atCap,
        capped: full && atCap,
        depth: depth!,
        engine: pin.engine,
        preferred: pin.engine === firstEngine(),
      },
      pin: { ...pin, steps },
    };
  };
  const replayed = pin.engine === 'database' ? pin.steps.slice(-1) : pin.steps;
  return rank(empty, pin.steps, replayed);
}
