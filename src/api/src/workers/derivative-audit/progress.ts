/**
 * In-process last-pass summary for the derivative-audit worker, read by
 * `GET /api/derivative-audit/status`. Mirrors how the mirror reconcile runner
 * publishes its progress (a module-level snapshot the route reads).
 */
import type { DerivativeAuditSummary } from './types.ts';

export function emptySummary(): DerivativeAuditSummary {
  return {
    scanned: 0,
    reArmed: 0,
    byStage: {},
    skippedCooldown: 0,
    errors: 0,
    startedAt: null,
    finishedAt: null,
    running: false,
  };
}

let current: DerivativeAuditSummary = emptySummary();

export function getDerivativeAuditProgress(): DerivativeAuditSummary {
  return current;
}

export function setDerivativeAuditProgress(s: DerivativeAuditSummary): void {
  current = s;
}
