/**
 * Migration: "Re-drive describe rows skipped on a missing preview".
 *
 * Before #2177 a describe run that found the 1280-px preview absent returned
 * `{ skip: 'preview-missing' }` — and a `skip` writes
 * `version = targetVersion`, marking the row permanently done. Every asset
 * that hit that branch (cache drift, a moved file, a preview write that never
 * landed) is therefore stamped done with no caption and nothing queued to
 * regenerate its preview. The new `{ rearm }` result fixes the behaviour going
 * forward, but changes nothing for rows already stamped.
 *
 * This migration resets the describe stage (full five-field reset) on exactly
 * those rows so the normal machinery re-claims them under the new code, which
 * then decides per asset: re-arm the preview stage (drift — the preview
 * regenerates and describe follows), or re-skip terminally (the preview stage
 * itself recorded a terminal `skip:`, e.g. `no-video-decoder` on a no-ffmpeg
 * host, where re-arming could never produce a poster).
 *
 * Only `stages.describe` is touched — the preview stage is deliberately NOT
 * reset here. Whether preview needs a re-run is the describe handler's call
 * (it can see whether the artefact is genuinely absent and why); resetting it
 * from the migration would re-render previews that are present and fine.
 *
 * Done-marker is `preview_missing_redrive_version`, mirroring
 * `video_poster_rearm_version` in `rearm-video-posters.ts`. Without it, a row
 * that legitimately re-skips under the new code (terminal video case writes
 * the same `skip: preview-missing` string) would re-enter the candidate set
 * the moment describe re-stamped it, and the migration would loop forever.
 * Bump `PREVIEW_MISSING_REDRIVE_VERSION` to sweep again.
 */

import type { ObjectId } from '../../db/object-id.ts';
import {
  countCandidates,
  rearmStagesAndStamp,
  unstamped,
  type CandidateScope,
} from '../../db/sqlite/repos/assets.migrations.ts';
import { child as childLogger } from '../../log.ts';

import { runRowBatch } from './row-batch.ts';
import type { Migration, MigrationBatchResult } from './types.ts';

const log = childLogger('migration:preview-missing-redrive');

const MIGRATION_ID = 'redrive-preview-missing-describe';

/** The exact `last_error` the runner's skip branch records for this case —
 * `skip: ${result.skip}` with describe's `preview-missing` reason. */
const SKIP_MARKER = 'skip: preview-missing';

/** Bump to re-sweep every previously-skipped row again. */
export const PREVIEW_MISSING_REDRIVE_VERSION = 1;

/** The one stage this sweep touches. Preview is deliberately NOT reset here —
 * whether it needs a re-run is the describe handler's call, because it can see
 * whether the artefact is genuinely absent and why. */
const REARMED_STAGES = ['describe'] as const;

/** Rows whose describe stage still carries the pre-#2177 terminal skip. This is
 * the half that has to be re-asserted at write time: a worker can legitimately
 * re-stamp the stage between this migration's read and its write. */
const SKIPPED_ON_PREVIEW: CandidateScope = {
  sql: `EXISTS (SELECT 1 FROM stage_state s
                 WHERE s.asset_id = a.id AND s.stage = 'describe' AND s.last_error = ?)`,
  params: [SKIP_MARKER],
};

/** Rows stamped done by the pre-#2177 terminal skip that this sweep hasn't
 * re-driven yet. */
function candidateScope(): CandidateScope {
  return unstamped(
    SKIPPED_ON_PREVIEW,
    'preview_missing_redrive_version',
    PREVIEW_MISSING_REDRIVE_VERSION,
  );
}

export const redrivePreviewMissingDescribe: Migration = {
  id: MIGRATION_ID,
  title: 'Re-drive describe rows skipped on a missing preview',
  description:
    'Re-queues assets whose describe stage was marked done with "skip: preview-missing" before ' +
    'the pipeline learned to re-arm the preview stage (#2177). Each re-driven row either ' +
    'regenerates its preview and gets captioned, or re-skips terminally where no preview can ' +
    'exist (e.g. video on a host without ffmpeg). One-time; idempotent per asset.',

  countRemaining(): Promise<number> {
    return countCandidates(candidateScope());
  },

  // No file I/O. This only moves stage bookkeeping; the actual preview/describe
  // work is done by the stage workers on their own schedule, under their own
  // concurrency limits, once these rows become claimable again. So a whole batch
  // is one transaction — see `row-batch.ts`.
  runBatch(batchSize: number): Promise<MigrationBatchResult> {
    return runRowBatch(
      candidateScope(),
      batchSize,
      log,
      {
        done: 're-drove preview-missing describe rows',
        failed: 're-drive batch failed — left for retry',
      },
      redriveRows,
    );
  },
};

/**
 * The write: re-arm describe and stamp the done-marker, for the rows that still
 * carry the pre-#2177 skip.
 *
 * The skip-marker half of the candidate predicate is re-asserted here, at write
 * time, rather than trusted from the read: a row can change in between (a worker
 * just re-stamped the describe stage), and an id-only update would reset that
 * fresh state and stamp the done-marker on something that is no longer a
 * candidate. A row that raced away is simply not modified — and not counted.
 */
function redriveRows(ids: readonly ObjectId[]): Promise<number> {
  return rearmStagesAndStamp(
    ids,
    REARMED_STAGES,
    'preview_missing_redrive_version',
    PREVIEW_MISSING_REDRIVE_VERSION,
    SKIPPED_ON_PREVIEW,
  );
}
