// Batch Rename for RAW+JPEG stacks (#5050). The server renames the selected
// RAWs from the template; each stacked RAW's JPEG then follows to the RAW's
// resulting stem, so a `{n}` template cannot pull the pair onto two stems.

import { Observable, catchError, concat, map, of, toArray } from 'rxjs';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { errorMessage } from '../util/errors';
import { companionFilenameFor } from '../models/asset-stack';
import type {
  BatchRenameApplyResult,
  BatchRenameCollisionPolicy,
  BatchRenameItemResult,
  ResolvedBatchRenameId,
} from './batch-rename.types';

type Companion = NonNullable<ResolvedBatchRenameId['companion']>;

function renameCompanion(
  api: BunApiBackendService,
  companion: Companion,
  rawNewFilename: string,
  collision: BatchRenameCollisionPolicy,
): Observable<BatchRenameItemResult> {
  const target = companionFilenameFor(companion.filename, rawNewFilename);
  return api.renameAsset(companion.address, target, collision).pipe(
    map(
      (outcome): BatchRenameItemResult =>
        outcome.kind === 'renamed'
          ? {
              address: companion.address,
              kind: 'relocated',
              oldFilename: companion.filename,
              newFilename: outcome.newFilename,
              renamedOnCollision: outcome.renamedOnCollision,
              extensionChanged: outcome.extensionChanged,
            }
          : { address: companion.address, kind: 'skipped', reason: outcome.reason },
    ),
    catchError((err) =>
      of<BatchRenameItemResult>({
        address: companion.address,
        kind: 'error',
        error: errorMessage(err),
      }),
    ),
  );
}

/** Rename, one after another, the companion of every stacked RAW that was relocated. */
export function renameCompanions(
  api: BunApiBackendService,
  resolved: readonly ResolvedBatchRenameId[],
  results: readonly BatchRenameItemResult[],
  collision: BatchRenameCollisionPolicy,
): Observable<BatchRenameItemResult[]> {
  const companionOf = new Map(resolved.map((row) => [row.address, row.companion]));
  const jobs = results.flatMap((item) => {
    const companion = item.kind === 'relocated' ? companionOf.get(item.address) : undefined;
    return item.kind === 'relocated' && companion
      ? [renameCompanion(api, companion, item.newFilename, collision)]
      : [];
  });
  return jobs.length === 0 ? of([]) : concat(...jobs).pipe(toArray());
}

/** Count each companion's outcome as one more file in the summary. */
export function mergeCompanionResults(
  applied: BatchRenameApplyResult,
  companions: readonly BatchRenameItemResult[],
): BatchRenameApplyResult {
  const count = (kind: BatchRenameItemResult['kind']) =>
    companions.filter((item) => item.kind === kind).length;
  const skipped = count('skipped');
  return {
    summary: {
      total: applied.summary.total + companions.length,
      relocated: applied.summary.relocated + count('relocated'),
      skipped: applied.summary.skipped + skipped,
      failed: applied.summary.failed + companions.length - count('relocated') - skipped,
    },
    results: [...applied.results, ...companions],
  };
}
