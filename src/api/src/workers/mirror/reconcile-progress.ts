/**
 * What `GET /api/mirror/status` reports about the operator's "Reconcile now":
 * the phase, per-stage counts, the current file and two capped logs. A
 * reconcile is a `mirror_reconcile` job row run by the worker tier; this reads
 * the latest such row, so the status is the same whichever process asks and
 * survives a restart.
 */

import type { JobWithId } from '../../db/schema.ts';

interface MirrorReconcileError {
  path: string;
  error: string;
  at: string;
}

export interface MirrorReconcileProgress {
  phase: 'idle' | 'scanning' | 'copying';
  scan: {
    /** Files checked against the mirror. */
    scanned: number;
    /** Found missing or stale, and queued to copy. */
    toCopy: number;
    upToDate: number;
    /** Stat errors while scanning, which never stop the scan. */
    errors: number;
  };
  copy: {
    /** Files queued to copy when the copy stage began. */
    total: number;
    /** Derived from the live queue, so a row the scheduled copy pass drained counts too. */
    copied: number;
    remaining: number;
    /** Dead-lettered during this run. */
    errors: number;
  };
  currentPath: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Most recent last, capped. */
  errorLog: MirrorReconcileError[];
  /** Most recent first, capped. */
  copiedLog: string[];
}

export const ERROR_LOG_CAP = 50;
export const COPIED_LOG_CAP = 100;

export function idleReconcile(): MirrorReconcileProgress {
  return {
    phase: 'idle',
    scan: { scanned: 0, toCopy: 0, upToDate: 0, errors: 0 },
    copy: { total: 0, copied: 0, remaining: 0, errors: 0 },
    currentPath: null,
    startedAt: null,
    finishedAt: null,
    errorLog: [],
    copiedLog: [],
  };
}

/** The snapshot a reconcile row carries, under this key, in its ledger while running and in its result once finished. */
export const RECONCILE_KEY = 'reconcile';

function carried(record: Record<string, unknown> | null | undefined) {
  const value = record?.[RECONCILE_KEY];
  return typeof value === 'object' && value !== null ? (value as MirrorReconcileProgress) : null;
}

/** A run that failed outright says why at the end of its error log. */
function withFailure(progress: MirrorReconcileProgress, job: JobWithId): MirrorReconcileProgress {
  if (job.status !== 'failed' || job.error === null) return progress;
  const failure = { path: '(reconcile)', error: job.error, at: job.updated_at };
  return { ...progress, errorLog: [...progress.errorLog, failure].slice(-ERROR_LOG_CAP) };
}

/** The progress of the latest reconcile row, or idle when there has never been one. */
export function reconcileProgressOf(job: JobWithId | null): MirrorReconcileProgress {
  if (job === null) return idleReconcile();
  const started = { ...idleReconcile(), phase: 'scanning' as const, startedAt: job.created_at };
  if (job.status === 'queued') return started;
  if (job.status === 'running') return carried(job.checkpoint) ?? started;
  const last = carried(job.result) ?? carried(job.checkpoint) ?? started;
  return withFailure(
    { ...last, phase: 'idle', currentPath: null, finishedAt: last.finishedAt ?? job.updated_at },
    job,
  );
}
