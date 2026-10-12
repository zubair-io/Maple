/**
 * The free-text branch of `GET /api/search`: one page of the request's ranked window (#4514).
 *
 * The window comes from `requestWindow` — the in-process engine when the child answers, the
 * database's inverted index otherwise — the same window the facets and buckets of this request count. Every filter of the
 * request — library, people, hidden, dates, vision fields, screenshot — is evaluated in SQL
 * against the engine's hits, so `total` and every page come from one filtered, ranked window and
 * nothing counts the whole match set. `more` tells the client a deeper page can widen the window;
 * `capped` that the window stopped at its 5,000-hit cap with matches left.
 *
 * Each page answers with a `rankPin`; a further page that sends it back is ranked by the same
 * engine over the same steps (`pinned-window.ts`, #4542), or — when that engine cannot answer —
 * — or when the pin belongs to another search — is refused with `engineChanged` so the client
 * restarts at page 0 rather than mixing rankings. A first page never takes a pin.
 */

import type { SearchWhere } from '../../db/repos/search.where.ts';
import {
  decodeRankPin,
  encodeRankPin,
  pinnedWindow,
  pinOf,
  type RankPin,
} from './pinned-window.ts';
import { requestWindow, windowPage, type WindowPage } from './ranked-window.ts';
import type { PhaseTimer } from './server-timing.ts';

export interface RankedListInput {
  /** Every filter of the date-resolved request (see `resolveRankedScope`). */
  where: SearchWhere;
  /** The residual free text an engine ranks. */
  childQuery: string;
  skip: number;
  limit: number;
  timing: PhaseTimer;
  /** The ranking earlier pages of this search were served from; null for a first page. */
  pin: RankPin | null;
}

type RankedListPage = (WindowPage & { rankPin: string }) | { engineChanged: true };

async function rankedListPage(input: RankedListInput): Promise<RankedListPage> {
  const { where, childQuery, skip, limit, timing, pin } = input;
  const request = { where, text: childQuery, need: skip + limit };
  const served = await timing.time('engine', async () => {
    if (pin === null) {
      const window = await requestWindow(request);
      return { window, pin: pinOf(window, request) };
    }
    return pinnedWindow(request, pin);
  });
  if (served === null) return { engineChanged: true };
  const page = await windowPage(served.window, { skip, limit, timing });
  return { ...page, rankPin: encodeRankPin(served.pin) };
}

/** The 409 a pinned page answers when its engine cannot rank it (#4542): restart at page 0. */
export const RANK_ENGINE_CHANGED = 'rank_engine_changed';

interface RankedListResponse {
  status: 200 | 400 | 409;
  body: Record<string, unknown>;
}

/** `GET /api/search`'s free-text answer, short of the fields every list response carries. */
export async function rankedListResponse(
  input: Omit<RankedListInput, 'pin'> & { rawPin: string | undefined },
): Promise<RankedListResponse> {
  const pin = input.rawPin === undefined ? null : decodeRankPin(input.rawPin);
  if (input.rawPin !== undefined && (pin === null || input.skip === 0)) {
    return {
      status: 400,
      body: { error: 'invalid rankPin: a pin from a previous page goes on the next' },
    };
  }
  const ranked = await rankedListPage({ ...input, pin });
  if ('engineChanged' in ranked) {
    return {
      status: 409,
      body: {
        error: 'the ranking earlier pages came from is unavailable; restart from page 0',
        code: RANK_ENGINE_CHANGED,
      },
    };
  }
  const { rankedBy, ...page } = ranked;
  return {
    status: 200,
    body: { ...page, cursorPaging: false, nextCursor: null, ...(rankedBy ? { rankedBy } : {}) },
  };
}
