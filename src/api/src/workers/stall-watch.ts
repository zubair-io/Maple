export const DEFAULT_STALL_AFTER_MINUTES = 60;

/** Tells a stalled stage apart from a busy or idle one on Settings → Workers (#5038). */
export class StallWatch {
  private lastProgressAt: number;
  private lastPollAt: number;
  private lastClaimAt: number | null = null;

  constructor(
    private readonly thresholdMs: () => number,
    now: number = Date.now(),
  ) {
    this.lastProgressAt = now;
    this.lastPollAt = now;
  }

  polled(now: number = Date.now()): void {
    this.lastPollAt = now;
  }

  claimed(count: number, inFlight: number, now: number = Date.now()): void {
    if (count === 0) return;
    const resumedFromIdle =
      inFlight === 0 && (this.lastClaimAt === null || now - this.lastClaimAt >= this.thresholdMs());
    if (resumedFromIdle) this.lastProgressAt = now;
    this.lastClaimAt = now;
  }

  progressed(now: number = Date.now()): void {
    this.lastProgressAt = now;
  }

  /** Deferrals count as claims, not progress; a stopped poll loop also stalls. */
  stalledForMs(inFlight: number, now: number = Date.now()): number | null {
    const thresholdMs = this.thresholdMs();
    const sinceProgress = now - this.lastProgressAt;
    if (sinceProgress < thresholdMs) return null;
    const working =
      inFlight > 0 || (this.lastClaimAt !== null && now - this.lastClaimAt < thresholdMs);
    const loopStopped = now - this.lastPollAt >= thresholdMs;
    return working || loopStopped ? sinceProgress : null;
  }
}
