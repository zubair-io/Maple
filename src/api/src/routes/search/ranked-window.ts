/**
 * The ranked window of a free-text request, whichever engine can rank it (#4514): the
 * in-process child when Settings → AI selects it and it answers, else the database's inverted
 * index. Both go through `rankWindow` (`db/repos/search.ranked.ts`), so the depth, the widening,
 * the cap and what `total` means are one policy for every route that ranks text.
 */

import {
  ftsRanker,
  mapleIdWindow,
  rankWindow,
  type RankedWindow,
  type WindowRanker,
} from '../../db/repos/search.ranked.ts';
import { windowDocs } from '../../db/repos/search.page.ts';
import type { SearchWhere } from '../../db/repos/search.where.ts';
import { inProcessRanking } from '../../search/search-engine-selection.ts';
import { libraryMaps } from './libraries.ts';
import { projectAssets, type SearchResult } from './project.ts';
import type { PhaseTimer } from './server-timing.ts';

export type WindowEngine = 'in-process' | 'database';

export interface EngineWindow extends RankedWindow {
  engine: WindowEngine;
}

/** The child's top `depth` hits, filtered by `where`. */
export function inProcessRanker(where: SearchWhere, query: string): WindowRanker {
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

/** The in-process window, or null when the child is not selected or not answering. */
export async function inProcessWindow(
  where: SearchWhere,
  query: string,
  need: number,
): Promise<EngineWindow | null> {
  const window = await rankWindow(inProcessRanker(where, query), need);
  return window && { ...window, engine: 'in-process' };
}

/** The database's window. It always answers: it is the floor every other engine falls to. */
export async function databaseWindow(where: SearchWhere, need: number): Promise<EngineWindow> {
  const window = await rankWindow(ftsRanker(where), need);
  return { ...(window ?? { rows: [], more: false, semantic: new Set() }), engine: 'database' };
}

/** The window for a request reaching `need` rows: the in-process engine's, else the database's. */
export async function searchWindow(
  where: SearchWhere,
  query: string,
  need: number,
): Promise<EngineWindow> {
  return (await inProcessWindow(where, query, need)) ?? databaseWindow(where, need);
}

export interface WindowPage {
  total: number;
  more: boolean;
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
    results,
    ...(rankedBy ? { rankedBy } : {}),
  };
}
