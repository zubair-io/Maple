/**
 * Time bounds for the expensive Mongo legs of `/api/search`.
 *
 * The Meili-miss fallback runs `$text` with OR semantics — a query like
 * "family barbecue park" matches every document containing ANY of those
 * words, which on a 333k-asset library is most of it — followed by a
 * blocking textScore sort over the whole match set, alongside a count that
 * is a documented ~2.5s O(N) scan (`total-cache.ts`). Unbounded, a broad
 * query holds its connection past the front proxy's patience; a few of them
 * concurrently and the origin stops answering — the intermittent Cloudflare
 * 502s of #2988.
 *
 * Bounding turns "origin down for everyone" into "this one query answers
 * 503 with a clear message". The limits are generous multiples of healthy
 * latencies (indexed finds answer in tens of ms; the worst measured count
 * is ~3.4s) so they only trip genuinely runaway plans.
 */

export const SEARCH_FIND_TIMEOUT_MS = 15_000;
export const SEARCH_COUNT_TIMEOUT_MS = 10_000;

/** Mongo's MaxTimeMSExpired server error code. */
const MAX_TIME_EXPIRED_CODE = 50;

export function isMaxTimeExpired(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === MAX_TIME_EXPIRED_CODE
  );
}

/** Wire body for a timed-out search — short JSON, so clients (which now
 * collapse HTML soup) show a sentence rather than a stack. */
export const SEARCH_TIMEOUT_BODY = {
  error: 'Search took too long — try a narrower query.',
} as const;

/**
 * Run the page fetch and the total count together, translating a Mongo
 * MaxTimeMSExpired on either leg into a `timedOut` marker the route maps to
 * 503. Extracted from `listRoute` (it pushed the handler past the size
 * budget) — and the pairing IS the unit: the two legs share one fate,
 * because a page without a total (or vice versa) renders nothing useful.
 */
export async function pageAndTotalOrTimeout<T>(
  page: Promise<T>,
  total: Promise<number>,
): Promise<{ timedOut: true } | { timedOut: false; docs: T; total: number }> {
  try {
    const [docs, count] = await Promise.all([page, total]);
    return { timedOut: false, docs, total: count };
  } catch (err) {
    if (isMaxTimeExpired(err)) return { timedOut: true };
    throw err;
  }
}
