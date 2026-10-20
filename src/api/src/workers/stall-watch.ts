/** A stage holding or claiming work with no progress this long is stalled. */
export const STALL_AFTER_MS = 15 * 60_000;

/**
 * Tracks when a stage last claimed work and last made progress, so Settings →
 * Workers can tell a stalled stage apart from a busy or idle one (#5038).
 * Deferrals are claims, not progress: a stage whose every claim defers is
 * stalled even though its loop keeps turning.
 */
export class StallWatch {
  private lastProgressAt: number;
  private lastClaimAt: number | null = null;

  constructor(now: number = Date.now()) {
    this.lastProgressAt = now;
  }

  claimed(count: number, now: number = Date.now()): void {
    if (count > 0) this.lastClaimAt = now;
  }

  progressed(now: number = Date.now()): void {
    this.lastProgressAt = now;
  }

  stalledForMs(inFlight: number, now: number = Date.now()): number | null {
    const working =
      inFlight > 0 || (this.lastClaimAt !== null && now - this.lastClaimAt < STALL_AFTER_MS);
    const sinceProgress = now - this.lastProgressAt;
    return working && sinceProgress >= STALL_AFTER_MS ? sinceProgress : null;
  }
}
