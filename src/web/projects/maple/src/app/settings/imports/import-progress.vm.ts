// Completion rate for an import job — the number behind the progress bar on
// `/settings/imports` and the `current / total` text on the Workers page.
//
// One definition, shared, because the two surfaces poll the same document and
// must never disagree about how far along a job is. Three rules the naive
// `current / total` misses:
//
//   1. A finished job reads 100%. A `done` import processed every file it
//      had, so the bar must land on full even if the counters raced with the
//      last write (or the job had nothing to do). Without this the UI parks a
//      completed import at 99% — or at 0% for a job whose file list was
//      empty, where `total` is 0 and the ratio is undefined.
//   2. A job that stopped early keeps its real ratio. `cancelled` and
//      `failed` did NOT process everything, so they must not be rounded up to
//      100% — the partial bar is the point.
//   3. The result is clamped to 0-100. `current` is written per file while
//      `total` is rewritten wholesale by a re-scan, so a retry can briefly
//      show a stale `current` against a smaller new `total`; a >100% bar (or
//      a fill wider than its track) is never what the operator should see.

import type { ImportStatus } from '@maple-common';

export interface ImportProgressLike {
  status: ImportStatus;
  progress: { current: number; total: number };
}

/** Whole-percent completion for one import job, in [0, 100]. */
export function importPercent(job: ImportProgressLike | null | undefined): number {
  if (!job) return 0;
  if (job.status === 'done') return 100;
  const { current, total } = job.progress;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((current / total) * 100)));
}
