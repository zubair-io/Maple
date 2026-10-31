/**
 * Network health for one derivative-audit pass. An R2 HEAD that fails because
 * the network is down says nothing about the thumbnail, so it is reported as
 * "could not tell" (`null`) rather than as absent — absent re-arms
 * `cf-thumb-sync`. Repeated failures with no success in between trip the pass
 * so a sustained outage stops hammering DNS instead of timing out on every row.
 */

/** Consecutive unreachable HEADs before the pass gives up. Two default-sized
 * chunks: a lone slow request never trips it, an outage does within seconds. */
export const R2_TRIP_AFTER_CONSECUTIVE_FAILURES = 16;

const TRANSIENT_CODES = new Set([
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ConnectionRefused',
  'ConnectionClosed',
  'FailedToOpenSocket',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const TRANSIENT_MESSAGE =
  /operation timed out|EAI_AGAIN|fetch failed|unable to connect|socket connection was closed|connection (reset|refused|closed)|R2 head failed \((429|5\d\d)\)/i;

/** True for failures of the path to R2 (DNS, connect, timeout, R2-side 429/5xx)
 * as opposed to an answer R2 gave about the request (bad credentials, 4xx). */
export function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return (
    err.name === 'TimeoutError' ||
    err.name === 'AbortError' ||
    (typeof code === 'string' && TRANSIENT_CODES.has(code)) ||
    TRANSIENT_MESSAGE.test(err.message)
  );
}

/** Many failures collapsed into what one log line needs. */
export class FailureDigest {
  count = 0;
  private firstError = '';
  private lastError = '';
  private sample = '';

  add(sample: string, message: string): void {
    if (this.count === 0) {
      this.firstError = message;
      this.sample = sample;
    }
    this.lastError = message;
    this.count++;
  }

  fields(): { count: number; firstError: string; lastError: string; sample: string } {
    return {
      count: this.count,
      firstError: this.firstError,
      lastError: this.lastError,
      sample: this.sample,
    };
  }
}

export interface R2Health {
  readonly digest: FailureDigest;
  readonly tripped: boolean;
  /** HEADs reported as "could not tell", including ones skipped once tripped. */
  readonly deferred: number;
  /** Wrap a HEAD so network failures become `null` and feed the breaker. */
  guard(head: (key: string) => Promise<boolean>): (key: string) => Promise<boolean | null>;
}

export function createR2Health(tripAfter = R2_TRIP_AFTER_CONSECUTIVE_FAILURES): R2Health {
  const digest = new FailureDigest();
  const state = { consecutive: 0, deferred: 0 };
  return {
    digest,
    get tripped() {
      return state.consecutive >= tripAfter;
    },
    get deferred() {
      return state.deferred;
    },
    guard: (head) => async (key) => {
      if (state.consecutive >= tripAfter) {
        state.deferred++;
        return null;
      }
      try {
        const present = await head(key);
        state.consecutive = 0;
        return present;
      } catch (err) {
        if (!isTransientNetworkError(err)) throw err;
        state.consecutive++;
        state.deferred++;
        digest.add(key, err instanceof Error ? err.message : String(err));
        return null;
      }
    },
  };
}
