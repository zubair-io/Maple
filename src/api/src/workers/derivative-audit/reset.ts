/**
 * The canonical 5-field stage re-arm (matches `reArmCacheStages` in
 * `workers/dedupe.helpers.ts` and `resetCfThumbSyncVersion` in
 * `stages/thumb.ts`) plus the per-asset cooldown key. Kept pure so it unit
 * tests without Mongo; the caller composes these fragments into `$set`.
 */

/** After this many audit re-arms that did NOT resolve the drift, stop
 * re-arming an asset+stage — the stage keeps marking itself done without
 * producing output (an imperfect skip-predicate would otherwise loop). */
export const AUDIT_MAX_ATTEMPTS = 3;

/** `$set` fragment that re-arms one stage (version → 0, clears bookkeeping). */
export function buildStageReset(stageName: string): Record<string, unknown> {
  return {
    [`stages.${stageName}.version`]: 0,
    [`stages.${stageName}.attempts`]: 0,
    [`stages.${stageName}.last_error`]: null,
    [`stages.${stageName}.processed_at`]: null,
    [`stages.${stageName}.dead`]: false,
  };
}

/** Dotted path to this stage's audit cooldown mark on the asset. */
export function auditMarkKey(stageName: string): string {
  return `derivative_audit.${stageName}`;
}
