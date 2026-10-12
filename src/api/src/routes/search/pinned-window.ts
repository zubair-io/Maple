/**
 * Keeping every page of one free-text search on one ranking (#4542).
 *
 * A search's first page is ranked by whichever engine answers (`requestWindow`). Its response
 * carries a `rankPin` — the engine and the ladder steps its window was ranked at — and the client
 * sends that back with each further page. A pinned page is ranked by that engine alone, replaying
 * the same steps, so it continues the ranking earlier pages were cut from. When the pinned engine
 * cannot answer, the page is not ranked by another engine: the caller tells the client to restart
 * from page 0 instead, because a different ranking's page N repeats rows already shown and skips
 * others.
 *
 * Replaying steps matters for the in-process engine: its fused ranking at depth 400 does not keep
 * the order of its ranking at depth 100 (each leg contributes deeper hits to the fusion). So a
 * pinned window is the first step's rows, then each deeper step's rows not already in it — every
 * served page stays a prefix of the next page's window. The database's order is total, so its
 * deeper windows extend shallower ones and only its deepest step needs ranking.
 */

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

/** The engine a search's pages are ranked by, and the ladder steps its window was built from. */
export interface RankPin {
  engine: WindowEngine;
  steps: readonly number[];
}

export function encodeRankPin(pin: RankPin): string {
  return `${pin.engine}:${pin.steps.join(',')}`;
}

/** A pin from its wire form, or null when it is not one this server minted. */
export function decodeRankPin(raw: string): RankPin | null {
  const [engine, steps, ...rest] = raw.trim().split(':');
  if (rest.length > 0 || (engine !== 'in-process' && engine !== 'database')) return null;
  const parsed = (steps ?? '').split(',').map((step) => (/^\d+$/.test(step) ? Number(step) : NaN));
  const onLadder = parsed.every(
    (step, index) => windowDepthFor(step) === step && (index === 0 || step > parsed[index - 1]!),
  );
  return parsed.length > 0 && onLadder ? { engine, steps: parsed } : null;
}

/** The pin of an unpinned request's window: the engine that answered and the step it served. */
export function pinOf(window: EngineWindow): RankPin {
  return { engine: window.engine, steps: [window.depth] };
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
 * The window of a pinned page, or null when the pinned engine cannot answer. Replays the pin's
 * steps, then widens up the ladder until the page's `need` is met, the engine runs out of hits,
 * or the cap is reached; `steps` is the pin the page's response carries.
 */
export async function pinnedWindow(
  request: WindowRequest,
  pin: RankPin,
): Promise<{ window: EngineWindow; steps: number[] } | null> {
  const ranker = engineRanker(pin.engine, request);
  const replayed = pin.engine === 'database' ? pin.steps.slice(-1) : pin.steps;
  const passes = await Promise.all(replayed.map((depth) => ranker(depth)));
  if (passes.some((pass) => pass === null)) return null;
  const empty: Merged = { rows: [], semantic: new Set(), scores: new Map() };
  const ranked = passes as WindowPass[];
  const start = ranked.reduce(merge, empty);
  const last = ranked.at(-1)!;

  const widen = async (
    merged: Merged,
    depth: number,
    full: boolean,
    steps: number[],
  ): Promise<{ window: EngineWindow; steps: number[] } | null> => {
    if (merged.rows.length >= request.need || !full || depth >= RANKED_WINDOW_MAX) {
      const atCap = depth >= RANKED_WINDOW_MAX;
      return {
        window: {
          ...merged,
          more: full && !atCap,
          capped: full && atCap,
          depth,
          engine: pin.engine,
          preferred: pin.engine === firstEngine(),
        },
        steps,
      };
    }
    const deeper = windowDepthFor(depth + 1);
    const pass = await ranker(deeper);
    if (pass === null) return null;
    return widen(merge(merged, pass), deeper, pass.considered >= deeper, [...steps, deeper]);
  };
  const deepest = pin.steps.at(-1)!;
  return widen(start, deepest, last.considered >= deepest, [...pin.steps]);
}
