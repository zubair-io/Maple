/**
 * The ranked window of a free-text request (#4514), from the first engine that answers: the
 * in-process child, the database's inverted index while the child cannot. Every engine goes
 * through `rankWindow` (`db/repos/search.ranked.ts`), so the depth, the widening, the cap and what
 * `total` means are one policy — and {@link requestWindow} is the one function the list, its
 * facets, its buckets and the For You collections take their window from, so all of them describe
 * the same set of photos for the same request.
 */

import {
  ftsRanker,
  inGivenOrder,
  mapleIdWindow,
  RANKED_WINDOW_BASE,
  RANKED_WINDOW_MAX,
  rankWindow,
  type RankedWindow,
  type WindowRanker,
} from '../../db/repos/search.ranked.ts';
import { windowDocs } from '../../db/repos/search.page.ts';
import type { SearchWhere } from '../../db/repos/search.where.ts';
import { inProcessRanking } from '../../search/search-ranking.ts';
import { libraryMaps } from './libraries.ts';
import { projectAssets, type SearchResult } from './project.ts';
import type { PhaseTimer } from './server-timing.ts';
import { clampInt, type SearchQuery } from './query.ts';

export type WindowEngine = 'in-process' | 'database';

export interface EngineWindow extends RankedWindow {
  engine: WindowEngine;
  /**
   * The first engine this request would ask answered it. False when a selected engine was down
   * and another stood in — an answer worth serving but not worth caching.
   */
  preferred: boolean;
}

/**
 * The child's top `depth` hits, filtered by `where`; the `lookahead` hits past them are filtered
 * too, but only so the window can tell which shot they are.
 */
function inProcessRanker(where: SearchWhere, query: string): WindowRanker {
  return async (depth, lookahead = 0) => {
    const hits = await inProcessRanking(query, depth + lookahead);
    if (!hits) return null;
    const ranked = hits.slice(0, depth);
    const ids = hits.slice(0, depth + lookahead).map((hit) => hit.id);
    const filtered = await mapleIdWindow(where, ids);
    const survivors = inGivenOrder(ids.slice(0, depth), filtered, (row) => row.maple_id);
    const alive = new Set(survivors.map((row) => row.maple_id));
    const surviving = ranked.filter((hit) => alive.has(hit.id));
    return {
      rows: survivors,
      beyond: inGivenOrder(ids.slice(depth), filtered, (row) => row.maple_id),
      considered: Math.min(hits.length, depth + lookahead),
      semantic: new Set(surviving.filter((hit) => hit.vectorRank !== null).map((hit) => hit.id)),
      scores: new Map(surviving.map((hit) => [hit.id, hit.score] as const)),
    };
  };
}

export interface WindowRequest {
  /** Every filter of the date-resolved request (see `resolveRankedScope`). */
  where: SearchWhere;
  /** The residual free text an engine ranks. */
  text: string;
  /** How many rows the request's page reaches; see {@link windowNeed}. */
  need: number;
  /** Stop widening at this many survivors; for a request with no pages to keep stable. */
  enough?: number;
}

interface Candidate {
  engine: WindowEngine;
  ranker: WindowRanker;
}

/**
 * How a request falls back. `search` asks the in-process engine, then the database. `collection` —
 * a For You card — is ranked by the in-process engine alone and answers null while it cannot, so
 * the card serves its stored preview rather than a different engine's ranking.
 */
export type WindowMode = 'search' | 'collection';

/** How `engine` ranks `request`'s text. */
export function engineRanker(engine: WindowEngine, request: WindowRequest): WindowRanker {
  return engine === 'in-process'
    ? inProcessRanker(request.where, request.text)
    : ftsRanker(request.where);
}

function candidates(request: WindowRequest, mode: WindowMode): Candidate[] {
  const engines: WindowEngine[] =
    mode === 'collection' ? ['in-process'] : ['in-process', 'database'];
  return engines.map((engine) => ({ engine, ranker: engineRanker(engine, request) }));
}

/**
 * The engine a search asks first, from the date-resolved request alone. Only its answer is ever
 * cached, so the facet and bucket caches key on it and never serve one engine's window for another.
 */
export function firstEngine(): WindowEngine {
  return 'in-process';
}

/**
 * The window a request is served from: the first engine that answers. A `collection` answers null
 * while its selected engine cannot — see {@link WindowMode}.
 */
export async function requestWindow(
  request: WindowRequest,
  mode: 'collection',
): Promise<EngineWindow | null>;
export async function requestWindow(request: WindowRequest): Promise<EngineWindow>;
export async function requestWindow(
  request: WindowRequest,
  mode: WindowMode = 'search',
): Promise<EngineWindow | null> {
  const engines = candidates(request, mode);
  const answers = await engines.reduce<Promise<EngineWindow[]>>(async (found, candidate) => {
    const earlier = await found;
    if (earlier.some(settles)) return earlier;
    const window = await rankWindow(candidate.ranker, request.need, request.enough);
    const answer = window && {
      ...window,
      engine: candidate.engine,
      preferred: candidate === engines[0] && earlier.length === 0,
    };
    return answer ? [...earlier, answer] : earlier;
  }, Promise.resolve([]));
  return answers.find(settles) ?? answers[0] ?? (mode === 'search' ? emptyWindow() : null);
}

/**
 * Whether an engine's answer is the request's answer. An empty window settles it only when the
 * engine had hits past the deepest window and the filters still left nothing — the next engine
 * would rank to the same bound and add cost, not truth. An empty window short of the cap means
 * the engine returned fewer hits than it was asked for, so the next engine is asked too, and the
 * empty answer stands only if none of them finds anything either.
 */
function settles(window: EngineWindow): boolean {
  return window.rows.length > 0 || window.capped || window.engine === 'database';
}

function emptyWindow(): EngineWindow {
  return {
    rows: [],
    more: false,
    capped: false,
    semantic: new Set(),
    depth: RANKED_WINDOW_BASE,
    engine: 'database',
    preferred: true,
  };
}

export interface WindowPage {
  total: number;
  more: boolean;
  capped: boolean;
  results: SearchResult[];
  rankedBy?: { engine: 'in-process'; semanticHits: number };
}

/**
 * One page of a window: its rows hydrated under `where` and projected. `total` is the window's
 * size less the page's rows that no longer pass `where` — an asset deleted or hidden since the
 * window was ranked — so a total never promises a row the page could not serve (#4545).
 */
export async function windowPage(
  window: EngineWindow,
  page: { where: SearchWhere; skip: number; limit: number; timing?: PhaseTimer },
): Promise<WindowPage> {
  const rows = window.rows.slice(page.skip, page.skip + page.limit);
  const hydrate = async () => {
    const [docs, { libs, idToSlug }] = await Promise.all([
      windowDocs(page.where, rows),
      libraryMaps(),
    ]);
    return projectAssets(docs, libs, idToSlug);
  };
  const results = page.timing ? await page.timing.time('rows', hydrate) : await hydrate();
  const rankedBy =
    window.engine === 'in-process'
      ? {
          engine: 'in-process' as const,
          semanticHits: rows.filter(
            (row) => row.maple_id !== null && window.semantic.has(row.maple_id),
          ).length,
        }
      : undefined;
  return {
    total: window.rows.length - (rows.length - results.length),
    more: window.more,
    capped: window.capped,
    results,
    ...(rankedBy ? { rankedBy } : {}),
  };
}

/**
 * The rows a request's page reaches — `(page + 1) × limit`, clamped as `GET /api/search` clamps
 * them — so facets and buckets asked with the list's own `page` and `limit` describe the same
 * window its `total` does.
 */
export function windowNeed(query: Pick<SearchQuery, 'page' | 'limit'>): number {
  const page = clampInt(query.page, 0, 10_000, 0);
  const limit = clampInt(query.limit, 1, 500, 100);
  return Math.min(RANKED_WINDOW_MAX, (page + 1) * limit);
}
