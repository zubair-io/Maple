/** Default stall threshold when a stage's `stallAfterMinutes` is unset. */
export const DEFAULT_STALL_AFTER_MINUTES = 60;

/** Tells a stalled stage apart from a busy or idle one on Settings → Workers (#5038). */
export class StallWatch {
  private lastProgressAt: number;
  private lastPollAt: number;
  private lastClaimAt: number | null = null;

  constructor(now: number = Date.now()) {
    this.lastProgressAt = now;
    this.lastPollAt = now;
  }

  polled(now: number = Date.now()): void {
    this.lastPollAt = now;
  }

  claimed(count: number, now: number = Date.now()): void {
    if (count > 0) this.lastClaimAt = now;
  }

  progressed(now: number = Date.now()): void {
    this.lastProgressAt = now;
  }

  /** Held or claimed work (deferrals are claims, not progress), or a poll loop
   * that stopped turning, with no progress for `thresholdMs`. */
  stalledForMs(inFlight: number, thresholdMs: number, now: number = Date.now()): number | null {
    const sinceProgress = now - this.lastProgressAt;
    if (sinceProgress < thresholdMs) return null;
    const working =
      inFlight > 0 || (this.lastClaimAt !== null && now - this.lastClaimAt < thresholdMs);
    const loopStopped = now - this.lastPollAt >= thresholdMs;
    return working || loopStopped ? sinceProgress : null;
  }
}
