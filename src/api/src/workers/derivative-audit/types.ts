/** Shared types for the derivative-audit worker. */

/** Result of one audit pass, also the shape published to the status route. */
export interface DerivativeAuditSummary {
  /** Assets examined this pass. */
  scanned: number;
  /** Total stage re-arms issued this pass. */
  reArmed: number;
  /** Re-arms broken down by stage name (thumb/preview/describe/cf-thumb-sync). */
  byStage: Record<string, number>;
  /** Drifted assets left untouched because they hit the per-asset cooldown. */
  skippedCooldown: number;
  /** Rows that raised an unexpected error during the pass. */
  errors: number;
  /** R2 lookups that could not be answered because the network was down; the
   * affected stages were left untouched and are re-checked next pass. */
  r2Deferred: number;
  /** Set when the pass stopped early; the loop retries soon instead of waiting
   * a full interval. */
  abortedReason: 'r2-unreachable' | null;
  startedAt: string | null;
  finishedAt: string | null;
  running: boolean;
}
