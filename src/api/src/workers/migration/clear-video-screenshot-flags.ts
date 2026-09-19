/**
 * Migration: "Clear video screenshot flags."
 *
 * `is_screenshot` is a stills-only concept (#2325), but videos could acquire
 * it three ways before the fix: the filename heuristic seeded it in the EXIF
 * stage, the VLM returned it for a poster frame that looked like a UI (a
 * screen recording does every time), and the sidecar re-index read that
 * verdict back. A flagged video drops out of the Photos bucket of the
 * Photos/Screenshots filter, and the prompt-v5 screenshot short-circuit also
 * nulled its whole scene description.
 *
 * The code fix only stops NEW flags. A stage does not re-run once its
 * version is stamped, so every video already carrying the flag keeps it
 * until this migration resets them.
 *
 * Why not bump the describe stage's targetVersion — the built-in "re-run
 * everything" mechanism? Because that re-queues the ENTIRE library through a
 * VLM inference per asset. Scoping to flagged video keeps the cost
 * proportional to the damage.
 *
 * Database-only: no file I/O, no decode, and so — unlike `rearm-video-posters`
 * — no ffmpeg precondition. The describe re-run itself happens later, on the
 * stage worker's own schedule and under its own concurrency limits.
 *
 * Known limitation: re-running describe on a genuine screen recording will
 * probably null the scene fields again, because the short-circuit lives in
 * the prompt and the model still sees a UI. The FLAG stays correct either
 * way, and the re-run does recover videos that were only ever misclassified
 * by the filename heuristic. Ticket #2158 (multi-frame video-describe) is
 * the better home for the description-quality half.
 *
 * Done-marker is `video_screenshot_clear_version`, mirroring
 * `video_poster_rearm_version` in `rearm-video-posters.ts`. Bump
 * `VIDEO_SCREENSHOT_CLEAR_VERSION` to sweep again.
 */

import {
  countCandidates,
  unstamped,
  type CandidateScope,
} from '../../db/sqlite/repos/assets.migrations.ts';
import {
  clearVideoScreenshotFlagRows as clearFlags,
  SCREENSHOT_VIDEO_SCOPE,
} from '../../db/sqlite/repos/assets.video-migrations.ts';
import { child as childLogger } from '../../log.ts';

import { runRowBatch } from './row-batch.ts';
import type { Migration, MigrationBatchResult } from './types.ts';

const log = childLogger('migration:video-screenshot');

const MIGRATION_ID = 'clear-video-screenshot-flags';

/** Bump to re-sweep every flagged video again. */
export const VIDEO_SCREENSHOT_CLEAR_VERSION = 1;

/** Videos with a live on-disk location still carrying the flag, either on
 * the top-level column or in the stored vision payload's mirror of it, that
 * haven't been cleared at the current version yet. */
function candidateScope(): CandidateScope {
  return unstamped(
    SCREENSHOT_VIDEO_SCOPE,
    'video_screenshot_clear_version',
    VIDEO_SCREENSHOT_CLEAR_VERSION,
  );
}

export const clearVideoScreenshotFlags: Migration = {
  id: MIGRATION_ID,
  title: 'Clear video screenshot flags',
  description:
    'Clears is_screenshot on videos that were wrongly classified as screenshots, and re-queues ' +
    'them through describe and meili so their scene description and search entry are rebuilt. ' +
    'Videos could pick up the flag from the filename heuristic or from the vision model reading ' +
    'a poster frame as a UI, which dropped them out of the Photos filter. One-time; idempotent ' +
    'per video.',

  countRemaining(): Promise<number> {
    return countCandidates(candidateScope());
  },

  // This migration only moves flags and stage bookkeeping, so a whole batch is
  // one transaction rather than the per-asset loop the file-moving migrations
  // need — see `row-batch.ts`.
  //
  // That one transaction covers both homes of the flag, the done-marker and the
  // stage re-arms. The Mongo version needed two `updateMany` calls in a specific
  // order to avoid stranding a row that carried the flag only in its vision
  // payload — cleared by the first write, then excluded from the retry if the
  // second failed. Either everything lands here or nothing does, so the whole
  // batch is simply retried.
  runBatch(batchSize: number): Promise<MigrationBatchResult> {
    return runRowBatch(
      candidateScope(),
      batchSize,
      log,
      {
        done: 'cleared video screenshot flags',
        failed: 'clear batch failed — left for retry',
      },
      (ids) => clearFlags(ids, VIDEO_SCREENSHOT_CLEAR_VERSION),
    );
  },
};
