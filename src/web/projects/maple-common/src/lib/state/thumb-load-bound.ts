// How many thumbnail requests may be in flight against the Self Hosted API at once.
//
// Over HTTP/1.1 the browser opens at most six connections to an origin, so four
// thumbnails leave two for every other /api/* call (#2219). Over HTTP/2 or HTTP/3
// one connection multiplexes every request and that cap does not apply; behind a
// distant edge the grid fills about four times faster at sixteen (#6192).
//
// The protocol comes from Resource Timing. Chromium reports an empty protocol for
// every response a service worker answers, the page load included, so the sign-in
// refresh bypasses the worker (`AuthService`) to leave one entry that names it.
// Until an entry names the protocol, the origin is treated as HTTP/1.1.

/** Thumb requests allowed in flight over HTTP/1.1, or while the protocol is unknown. */
export const MAX_CONCURRENT_THUMB_LOADS = 4;

/** Thumb requests allowed in flight once the origin is known to speak HTTP/2 or HTTP/3. */
export const MULTIPLEXED_THUMB_LOADS = 16;

type TimingEntries = Pick<Performance, 'getEntriesByType'>;

/**
 * A bound for thumbnails fetched from `origin`. It is re-read on every call until
 * an entry names the protocol, then fixed, so a settled bound costs nothing per load.
 */
export function thumbLoadBound(
  origin: string = globalThis.location?.origin ?? '',
  timing: TimingEntries | undefined = globalThis.performance,
): () => number {
  let settled: number | undefined;
  return () => {
    if (settled !== undefined) return settled;
    const protocol = latestProtocol(origin, timing);
    if (protocol === undefined) return MAX_CONCURRENT_THUMB_LOADS;
    settled = isMultiplexed(protocol) ? MULTIPLEXED_THUMB_LOADS : MAX_CONCURRENT_THUMB_LOADS;
    return settled;
  };
}

function latestProtocol(origin: string, timing: TimingEntries | undefined): string | undefined {
  const entries = timing
    ? [...timing.getEntriesByType('navigation'), ...timing.getEntriesByType('resource')]
    : [];
  return entries
    .filter((entry): entry is PerformanceResourceTiming => 'nextHopProtocol' in entry)
    .filter((entry) => entry.nextHopProtocol !== '' && new URL(entry.name).origin === origin)
    .at(-1)?.nextHopProtocol;
}

function isMultiplexed(protocol: string): boolean {
  return protocol === 'h2' || protocol.startsWith('h3');
}
