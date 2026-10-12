/**
 * The ranked window of a free-text request (#4514), from the first engine that answers: the
 * in-process child when Settings → AI selects it, Meilisearch when it is configured and can
 * express the request's filters, the database's inverted index otherwise. Every engine goes
 * through `rankWindow` (`db/repos/search.ranked.ts`), so the depth, the widening, the cap and what
 * `total` means are one policy — and {@link requestWindow} is the one function the list, its
 * facets, its buckets and the For You collections take their window from, so all of them describe
 * the same set of photos for the same request.
 */

import {
  ftsRanker,
  mapleIdWindow,
  RANKED_WINDOW_MAX,
  rankWindow,
  type RankedWindow,
  type WindowRanker,
} from '../../db/repos/search.ranked.ts';
import { windowDocs } from '../../db/repos/search.page.ts';
import type { SearchWhere } from '../../db/repos/search.where.ts';
import { inProcessRanking, inProcessSelected } from '../../search/search-engine-selection.ts';
import { meiliRanker, meiliServes } from './list-meili.ts';
import { libraryMaps } from './libraries.ts';
import { projectAssets, type SearchResult } from './project.ts';
import type { PhaseTimer } from './server-timing.ts';
import { clampInt, type SearchQuery } from './query.ts';

export type WindowEngine = 'in-process' | 'meilisearch' | 'database';

export interface EngineWindow extends RankedWindow {
  engine: WindowEngine;
  /**
   * The first engine this request would ask answered it. False when a selected engine was down
   * and another stood in — an answer worth serving but not worth caching.
   */
  preferred: boolean;
}

/** The child's top `depth` hits, filtered by `where`. */
function inProcessRanker(where: SearchWhere, query: string): WindowRanker {
  return async (depth) => {
    const hits = await inProcessRanking(query, depth);
    if (!hits) return null;
    const ranked = hits.slice(0, depth);
    return {
      rows: await mapleIdWindow(
        where,
        ranked.map((hit) => hit.id),
      ),
      considered: ranked.length,
      semantic: new Set(ranked.filter((hit) => hit.vectorRank !== null).map((hit) => hit.id)),
    };
  };
}

export interface WindowRequest {
  /** Every filter of the date-resolved request (see `resolveRankedScope`). */
  where: SearchWhere;
  resolved: SearchQuery;
  /** The residual free text an engine ranks. */
  text: string;
  libraryId: string | undefined;
  /** How many rows the request's page reaches; see {@link windowNeed}. */
  need: number;
}

interface Candidate {
  engine: WindowEngine;
  ranker: WindowRanker;
}

/**
 * How a request falls back. `search` asks every engine that applies, the database last. `collection`
 * — a For You card — is ranked by the selected in-process engine alone when it is selected, and
 * answers null while it cannot, so the card serves its stored preview rather than a different
 * engine's ranking; with in-process not selected it falls back like a search.
 */
export type WindowMode = 'search' | 'collection';

async function candidates(request: WindowRequest, mode: WindowMode): Promise<Candidate[]> {
  const { where, resolved, text, libraryId } = request;
  const inProcess = await inProcessSelected();
  if (inProcess && mode === 'collection') {
    return [{ engine: 'in-process', ranker: inProcessRanker(where, text) }];
  }
  const meili = meiliRanker(where, resolved, libraryId);
  return [
    ...(inProcess ? [{ engine: 'in-process' as const, ranker: inProcessRanker(where, text) }] : []),
    ...(meili ? [{ engine: 'meilisearch' as const, ranker: meili }] : []),
    { engine: 'database' as const, ranker: ftsRanker(where) },
  ];
}

/**
 * The engine a search asks first, from the date-resolved request alone. Only its answer is ever
 * cached, so the facet and bucket caches key on it and never serve one engine's window for another.
 */
export async function firstEngine(resolved: SearchQuery): Promise<WindowEngine> {
  if (await inProcessSelected()) return 'in-process';
  return meiliServes(resolved) ? 'meilisearch' : 'database';
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
  const engines = await candidates(request, mode);
  const answers = await engines.reduce<Promise<EngineWindow[]>>(async (found, candidate) => {
    const earlier = await found;
    if (earlier.some(settles)) return earlier;
    const window = await rankWindow(candidate.ranker, request.need);
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
 * engine searched as deep as a window goes and the filters still left nothing — the next engine
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

/** One page of a window: its rows hydrated and projected, `total` the window's size. */
export async function windowPage(
  window: EngineWindow,
  page: { skip: number; limit: number; timing?: PhaseTimer },
): Promise<WindowPage> {
  const rows = window.rows.slice(page.skip, page.skip + page.limit);
  const hydrate = async () => {
    const [docs, { libs, idToSlug }] = await Promise.all([windowDocs(rows), libraryMaps()]);
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
    total: window.rows.length,
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
