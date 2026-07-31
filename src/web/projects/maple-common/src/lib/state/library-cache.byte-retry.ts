// library-cache.byte-retry.ts — bounded retry with short backoff for
// transient HTTP failures on the byte-read path (#2407).
//
// The M2 (`slug:relPath`) network byte fetch used to be a single unguarded
// GET: one transient blip during the reload cold-start burst (auth refresh +
// folder list + `POST /api/scan` + byte fetch racing) surfaced as a
// permanent blank canvas with no recovery and no visible error. This gives
// that GET three attempts with a short backoff before it reaches the caller.
//
// Only network drops (status 0), 429, and 5xx are retried — those are the
// transport/server failures a retry can plausibly fix. 4xx (404/403/etc.) is
// not retried: the resource genuinely isn't there or isn't authorized, and
// retrying just wastes the attempts before the caller can surface the real
// error. 401 is excluded too — `auth.interceptor.ts` already owns a single
// refresh-then-retry for it, so retrying here would double up.

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [250, 1000];

/** True for an HttpErrorResponse-shaped error worth retrying — status 0
 *  (network/CORS failure that never reached a server), 429, or 5xx. */
export function isTransientFetchError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (status === undefined) return false;
  if (status === 0 || status === 429) return true;
  return status >= 500 && status < 600;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry `attempt` up to {@link MAX_ATTEMPTS} times with a short backoff
 * ({@link BACKOFF_MS}), but only while the failure is transient (see
 * {@link isTransientFetchError}) — a non-transient failure, or the final
 * attempt, rejects immediately with the underlying error.
 */
export async function withTransientRetry<T>(attempt: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (i >= MAX_ATTEMPTS - 1 || !isTransientFetchError(err)) throw err;
      await delay(BACKOFF_MS[i]);
    }
  }
}
