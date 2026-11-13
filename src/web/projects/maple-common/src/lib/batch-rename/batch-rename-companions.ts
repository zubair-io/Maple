// Batch Rename for RAW+JPEG stacks (#5050). The server renames the selected
// RAWs from the template; each stacked RAW's JPEG then follows to the RAW's
// resulting stem, so a `{n}` template cannot pull the pair onto two stems.
//
// A pair is one tile but two renames. The JPEG is always sent with
// `collision: 'skip'`: the batch's Replace was chosen for the RAWs the
// preview listed, never for an unrelated file that holds the JPEG's target.
// When that name is taken, Skip and Replace leave the JPEG under its name and
// list it by name; Keep Both and Auto-suffix move the pair together to one
// `<stem>.N` free for the RAW, the JPEG and their sidecar.

import { Observable, catchError, concat, map, of, switchMap, toArray } from 'rxjs';
import { BunApiBackendService, type ApiRenameOutcome } from '../api/bun-api-backend.service';
import {
  formatAddress,
  parentAddress,
  parseAddress,
  siblingAddress,
} from '../addressing/maple-address';
import { FolderOccupancyService } from '../stack/folder-occupancy.service';
import { companionFilenameFor, freePairFilename } from '../stack/stack-pair-names';
import { errorMessage } from '../util/errors';
import type {
  BatchRenameApplyResult,
  BatchRenameCollisionPolicy,
  BatchRenameItemResult,
  BatchRenamePreviewItem,
  ResolvedBatchRenameId,
} from './batch-rename.types';

type Companion = NonNullable<ResolvedBatchRenameId['companion']>;
type Relocated = Extract<BatchRenameItemResult, { kind: 'relocated' }>;

/** One stacked RAW's outcome: its own row (changed when the pair moved to a
 * free stem) and its JPEG's row. */
interface PairOutcome {
  readonly raw: Relocated;
  readonly companion: BatchRenameItemResult;
}

export interface CompanionDeps {
  readonly api: BunApiBackendService;
  readonly occupancy: FolderOccupancyService;
}

/** Preview rows with each stacked RAW's JPEG listed right after it, under the
 * name it will take. */
export function withCompanionPreview(
  items: readonly BatchRenamePreviewItem[],
  resolved: readonly ResolvedBatchRenameId[],
): BatchRenamePreviewItem[] {
  const companionOf = new Map(resolved.map((row) => [row.address, row.companion]));
  return items.flatMap((item) => {
    const companion = companionOf.get(item.address);
    if (!companion) return [item];
    const follows: BatchRenamePreviewItem = {
      address: companion.address,
      oldFilename: companion.filename,
      newFilename: item.newFilename
        ? companionFilenameFor(companion.filename, item.newFilename)
        : null,
      error: item.error ? `follows ${item.oldFilename ?? 'its RAW'}: ${item.error}` : null,
      duplicate: false,
    };
    return [item, follows];
  });
}

function companionResult(
  companion: Companion,
  outcome: ApiRenameOutcome,
  target: string,
): BatchRenameItemResult {
  if (outcome.kind === 'renamed') {
    return {
      address: companion.address,
      kind: 'relocated',
      oldFilename: companion.filename,
      newFilename: outcome.newFilename,
      renamedOnCollision: outcome.renamedOnCollision,
      extensionChanged: outcome.extensionChanged,
    };
  }
  const reason =
    outcome.reason === 'collision'
      ? `${target} already exists, so ${companion.filename} kept its name`
      : outcome.reason;
  return { address: companion.address, kind: 'skipped', reason };
}

function failed(companion: Companion, err: unknown): BatchRenameItemResult {
  return { address: companion.address, kind: 'error', error: errorMessage(err) };
}

/** Keep Both / Auto-suffix after the JPEG's target turned out to be taken:
 * move the RAW on to the first name free for both files, then the JPEG. */
function moveToFreeStem(
  deps: CompanionDeps,
  companion: Companion,
  raw: Relocated,
): Observable<PairOutcome> {
  const rawAddress = siblingAddress(raw.address, raw.newFilename);
  const parsed = parseAddress(rawAddress);
  const folder = formatAddress(parentAddress(parsed) ?? { slug: parsed.slug, relPath: '' });
  const keepSplit = (reason: string): PairOutcome => ({
    raw,
    companion: { address: companion.address, kind: 'skipped', reason },
  });
  return deps.occupancy.occupiedNames(folder).pipe(
    switchMap((occupied) => {
      const free = freePairFilename(occupied, raw.newFilename, companion.filename);
      if (!free) return of(keepSplit(`no free name for ${raw.newFilename} and its JPEG`));
      return deps.api.renameAsset(rawAddress, free, 'skip').pipe(
        switchMap((outcome) => {
          if (outcome.kind !== 'renamed') return of(keepSplit(`${free} was taken meanwhile`));
          const movedRaw: Relocated = { ...raw, newFilename: free, renamedOnCollision: true };
          const target = companionFilenameFor(companion.filename, free);
          return deps.api.renameAsset(companion.address, target, 'skip').pipe(
            map((jpeg) => ({ raw: movedRaw, companion: companionResult(companion, jpeg, target) })),
            catchError((err) => of({ raw: movedRaw, companion: failed(companion, err) })),
          );
        }),
      );
    }),
    catchError((err) => of({ raw, companion: failed(companion, err) })),
  );
}

function followRaw(
  deps: CompanionDeps,
  companion: Companion,
  raw: Relocated,
  collision: BatchRenameCollisionPolicy,
): Observable<PairOutcome> {
  const target = companionFilenameFor(companion.filename, raw.newFilename);
  const suffixing = collision === 'keep-both' || collision === 'auto-suffix';
  return deps.api.renameAsset(companion.address, target, 'skip').pipe(
    switchMap((outcome) =>
      outcome.kind === 'skipped' && outcome.reason === 'collision' && suffixing
        ? moveToFreeStem(deps, companion, raw)
        : of({ raw, companion: companionResult(companion, outcome, target) }),
    ),
    catchError((err) => of({ raw, companion: failed(companion, err) })),
  );
}

/** Rename, one after another, the companion of every stacked RAW that was
 * relocated; RAWs that were skipped or failed leave their JPEG alone. */
export function renameCompanions(
  deps: CompanionDeps,
  resolved: readonly ResolvedBatchRenameId[],
  applied: BatchRenameApplyResult,
  collision: BatchRenameCollisionPolicy,
): Observable<BatchRenameApplyResult> {
  const companionOf = new Map(resolved.map((row) => [row.address, row.companion]));
  const jobs = applied.results.flatMap((item) => {
    const companion = item.kind === 'relocated' ? companionOf.get(item.address) : undefined;
    return item.kind === 'relocated' && companion
      ? [followRaw(deps, companion, item, collision)]
      : [];
  });
  return jobs.length === 0
    ? of(applied)
    : concat(...jobs).pipe(
        toArray(),
        map((pairs) => mergePairs(applied, pairs)),
      );
}

/** The summary counts tiles: a pair whose JPEG did not follow is counted as
 * skipped or failed instead of renamed, and the JPEG's row names it. */
function mergePairs(
  applied: BatchRenameApplyResult,
  pairs: readonly PairOutcome[],
): BatchRenameApplyResult {
  const byAddress = new Map(pairs.map((pair) => [pair.raw.address, pair]));
  const split = (kind: BatchRenameItemResult['kind']) =>
    pairs.filter((pair) => pair.companion.kind === kind).length;
  const skipped = split('skipped');
  const failedCount = pairs.length - split('relocated') - skipped;
  return {
    summary: {
      total: applied.summary.total,
      relocated: applied.summary.relocated - skipped - failedCount,
      skipped: applied.summary.skipped + skipped,
      failed: applied.summary.failed + failedCount,
    },
    results: applied.results.flatMap((item) => {
      const pair = byAddress.get(item.address);
      return pair ? [pair.raw, pair.companion] : [item];
    }),
  };
}
