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
import { meiliRanker } from './list-meili.ts';
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

async function candidates(request: WindowRequest, databaseFloor: boolean): Promise<Candidate[]> {
  const { where, resolved, text, libraryId } = request;
  const meili = meiliRanker(where, resolved, libraryId);
  return [
    ...((await inProcessSelected())
      ? [{ engine: 'in-process' as const, ranker: inProcessRanker(where, text) }]
      : []),
    ...(meili ? [{ engine: 'meilisearch' as const, ranker: meili }] : []),
    ...(databaseFloor ? [{ engine: 'database' as const, ranker: ftsRanker(where) }] : []),
  ];
}

/**
 * The window a request is served from: the first engine that answers. With `databaseFloor` off it
 * answers null when no engine but the database could — the For You collection's case, which
 * serves its stored preview then rather than ranking the library in the database.
 */
export async function requestWindow(
  request: WindowRequest,
  databaseFloor: false,
): Promise<EngineWindow | null>;
export async function requestWindow(request: WindowRequest): Promise<EngineWindow>;
export async function requestWindow(
  request: WindowRequest,
  databaseFloor: boolean,
): Promise<EngineWindow | null>;
export async function requestWindow(
  request: WindowRequest,
  databaseFloor = true,
): Promise<EngineWindow | null> {
  const engines = await candidates(request, databaseFloor);
  const answer = await engines.reduce<Promise<EngineWindow | null>>(async (found, candidate) => {
    const earlier = await found;
    if (earlier) return earlier;
    const window = await rankWindow(candidate.ranker, request.need);
    return window && { ...window, engine: candidate.engine, preferred: candidate === engines[0] };
  }, Promise.resolve(null));
  return answer ?? (databaseFloor ? emptyWindow() : null);
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
