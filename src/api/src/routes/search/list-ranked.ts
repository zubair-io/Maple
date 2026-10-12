/**
 * The free-text branch of `GET /api/search`: one page of the request's ranked window (#4514).
 *
 * The window comes from `requestWindow` — the in-process engine when Settings → AI selects it
 * and the child answers, Meilisearch when it is configured, the database's inverted index
 * otherwise — the same window the facets and buckets of this request count. Every filter of the
 * request — library, people, hidden, dates, vision fields, screenshot — is evaluated in SQL
 * against the engine's hits, so `total` and every page come from one filtered, ranked window and
 * nothing counts the whole match set. `more` tells the client a deeper page can widen the window;
 * `capped` that the window stopped at its 5,000-hit cap with matches left.
 */

import type { SearchWhere } from '../../db/repos/search.where.ts';
import type { SearchQuery } from './query.ts';
import { requestWindow, windowPage, type WindowPage } from './ranked-window.ts';
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
  const window = await timing.time('engine', () =>
    requestWindow({ where, resolved, text: childQuery, libraryId, need: skip + limit }),
  );
  return windowPage(window, { skip, limit, timing });
}
