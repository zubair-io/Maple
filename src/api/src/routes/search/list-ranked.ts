/**
 * The free-text branch of `GET /api/search`: one page of the request's ranked window (#4514).
 *
 * The in-process engine ranks it when Settings → AI selects it and the child answers;
 * Meilisearch when it is configured; the database's inverted index otherwise. Every filter of the
 * request — library, people, hidden, dates, vision fields, screenshot — is evaluated in SQL
 * against the engine's hits, so `total` and every page come from one filtered, ranked window and
 * nothing counts the whole match set. `more` tells the client a deeper page can widen the window.
 */

import { meiliPage } from './list-meili.ts';
import type { SearchWhere } from '../../db/repos/search.where.ts';
import type { SearchQuery } from './query.ts';
import { databaseWindow, inProcessWindow, windowPage, type WindowPage } from './ranked-window.ts';
import type { PhaseTimer } from './server-timing.ts';

export interface RankedListInput {
  /** Every filter of the date-resolved request (see `resolveRankedScope`). */
  where: SearchWhere;
  resolved: SearchQuery;
  /** The residual free text an engine ranks. */
  childQuery: string;
  libraryId: string | undefined;
  skip: number;
  limit: number;
  timing: PhaseTimer;
}

export async function rankedListPage(input: RankedListInput): Promise<WindowPage> {
  const { where, resolved, childQuery, libraryId, skip, limit, timing } = input;
  const need = skip + limit;
  const page = { skip, limit, timing };
  const inProcess = await timing.time('engine', () => inProcessWindow(where, childQuery, need));
  if (inProcess) return windowPage(inProcess, page);
  const meili = await meiliPage({ where, resolved, libraryId, skip, limit, timing });
  if (meili) return { total: meili.total, more: false, results: meili.results };
  return windowPage(await timing.time('fts', () => databaseWindow(where, need)), page);
}
