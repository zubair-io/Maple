/**
 * Network health for one derivative-audit pass. An R2 HEAD that fails because
 * the network is down says nothing about the thumbnail, so it is reported as
 * "could not tell" (`null`) rather than as absent — absent re-arms
 * `cf-thumb-sync`. Repeated failures with no success in between trip the pass
 * so a sustained outage stops hammering DNS instead of timing out on every row.
 */

import { isTransientNetworkError } from '../../cloudflare/r2-network-error.ts';

/** Consecutive unreachable HEADs before the pass gives up. Two default-sized
 * chunks: a lone slow request never trips it, an outage does within seconds. */
export const R2_TRIP_AFTER_CONSECUTIVE_FAILURES = 16;

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
