/**
 * ThroughputWindow — rolling completion counter for the status API.
 *
 * Counts how many docs completed within the trailing `windowMs`. Read on
 * EVERY `/api/workers/status` call and EVERY 250ms `/api/events` WS frame,
 * so the read must be cheap and independent of throughput.
 *
 * Implementation — fixed one-second time buckets in a ring. Each second of
 * the window owns one slot; `record()` bumps the slot for the entry's own
 * second, `countInWindow()` sums the slots still inside the window. Both are
 * O(window-in-seconds) — a small constant (~300) regardless of how many
 * completions have been recorded, replacing the old `number[]` + `.filter()`
 * that grew to 10^5–10^6 entries and cost 10–50ms per read.
 *
 * Each slot is tagged with the ABSOLUTE second-bucket it currently holds, so
 * the ring is robust to:
 *   - out-of-order / backdated records (the entry's own timestamp picks the
 *     slot, not a moving head),
 *   - ring wraparound (a stale slot is lazily zeroed when its bucket id no
 *     longer matches before we add to it),
 *   - reads that exclude future-dated (clock-skewed) buckets.
 */

export class ThroughputWindow {
  private readonly windowMs: number;
  /** Number of one-second slots covering the window (+1 for the current second). */
  private readonly slotCount: number;
  /**
   * Absolute second-bucket id currently held by each slot (-1 = empty).
   * Plain number[] (not Int32Array): a second-bucket is `Date.now()/1000`,
   * which crosses the Int32 ceiling in 2038 — and the tests use far-future
   * timestamps deliberately. Float64 holds it exactly.
   */
  private readonly slotBucket: number[];
  /** Completion count held by each slot. */
  private readonly slotHits: number[];

  constructor(windowMs: number = 300_000) {
    this.windowMs = windowMs;
    this.slotCount = Math.ceil(windowMs / 1000) + 1;
    this.slotBucket = new Array<number>(this.slotCount).fill(-1);
    this.slotHits = new Array<number>(this.slotCount).fill(0);
  }

  record(processedAt: Date): void {
    const bucket = Math.floor(processedAt.getTime() / 1000);
    const slot = ((bucket % this.slotCount) + this.slotCount) % this.slotCount;
    if (this.slotBucket[slot] !== bucket) {
      // Slot is reused for a new second — reset it before counting.
      this.slotBucket[slot] = bucket;
      this.slotHits[slot] = 0;
    }
    this.slotHits[slot]!++;
  }

  countInWindow(nowMs: number = Date.now()): number {
    const nowBucket = Math.floor(nowMs / 1000);
    // Buckets within the trailing window: those with timestamp
    // >= nowMs - windowMs. Upper-bounded at nowBucket so a future-dated
    // (clock-skewed) record can't inflate the count.
    const cutoffBucket = Math.floor((nowMs - this.windowMs) / 1000);
    let total = 0;
    for (let i = 0; i < this.slotCount; i++) {
      const bucket = this.slotBucket[i]!;
      // A bucket exactly at cutoffBucket may straddle the cutoff edge — include
      // it (matches the old `t >= cutoff` boundary at second granularity;
      // harmless one-second slack on a 300s window).
      if (bucket >= cutoffBucket && bucket <= nowBucket) {
        total += this.slotHits[i]!;
      }
    }
    return total;
  }
}
