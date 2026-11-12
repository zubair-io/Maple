/**
 * DeDuplicate worker — collapses an asset that has more than one live on-disk
 * location (the byte-identical same content found at several paths) down to a
 * single kept copy. Every other copy's original file (plus its paired XMP
 * sidecars) is RELOCATED into `<libraryRoot>/_duplicates/<original rel path>`
 * and its location row is removed from the asset.
 *
 * Why this is safe under "originals are sacred": nothing is deleted. A duplicate
 * is *moved* into a reversible quarantine folder that the indexer skips (see
 * `DUPLICATES_DIR_NAME` in `fs/duplicates.ts`), and the worker boots PAUSED — it
 * does nothing until an operator resumes it from /settings/workers. A `dry_run`
 * config knob previews the moves without touching disk.
 *
 * `.keep` override: a `.keep` marker file in a folder PINS every copy living
 * there. When any on-disk copy of an asset is pinned, the worker keeps all
 * pinned copies (there may be more than one) and collapses only the un-pinned
 * ones; if every copy is pinned the asset is left untouched. The marker is
 * re-confirmed on disk each pass, so adding/removing a `.keep` takes effect
 * without re-indexing. The ranking below applies only to UN-pinned sets.
 *
 * Which copy is KEPT: see the ranking spec in `dedupe.helpers.ts` (the
 * `selectKeeper` / `removalScore` docs are the single source of truth).
 *
 * Derived data:
 *   - XMP sidecars travel into `_duplicates` alongside the moved file (edits
 *     preserved & restorable) via `moveToDuplicates`.
 *   - Thumbs are `maple_id`-keyed and SHARED by every location, so a moved
 *     copy's thumb is cleaned only when the kept copy is NOT in that folder
 *     (else it would delete the kept copy's live cache). Previews are
 *     path-keyed (not `maple_id`-keyed — see `cachePathForAsset`'s doc), so
 *     they have no such sharing to preserve: a moved copy's previews are
 *     always cleaned at its old location regardless of where the keeper
 *     lives. When the cache anchor (the first location, `ordinal = 0`) is one
 *     of the moved copies, the `thumb`/`preview` stages are re-armed so the
 *     kept copy regenerates them at its location (the serving route 404s on a
 *     cache miss; it does not lazily render).
 *
 * Not a per-asset version-claim stage: its passes run every five minutes as the
 * `deduplicate` maintenance task (`workers/maintenance/`), and it registers
 * into the in-process `stageRegistry` so the standard
 * `/api/workers/deduplicate/{status,pause,resume}` surface controls it.
 */

import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { isLiveFileInfo } from '../indexer/images.repo.ts';
import { recordAndPublishAssetChange } from '../db/repos/changes.repo.ts';
import { listDuplicateCandidates, type DuplicateCandidate } from '../db/repos/assets.sweeps.ts';
import { child as childLogger } from '../log.ts';
import { pausableWorker, type RegisteredWorker } from './pause-control.ts';
import { loadDeDuplicateConfig, DEFAULT_BATCH_SIZE } from './dedupe-config.repo.ts';
import { emptySummary, type DeDuplicateSummary } from './dedupe.helpers.ts';
import {
  resolveOnDiskEntries,
  resolveKeepersAndRemovals,
  resolveKeeperContext,
  moveEntriesToDuplicates,
  pullMovedEntriesFromFileinfo,
} from './dedupe.process-asset.ts';

const log = childLogger('deduplicate');

/** Registry / route key. Matches `/api/workers/deduplicate/...`. */
export const DEDUPLICATE_NAME = 'deduplicate';

export interface RunDeDuplicateOptions {
  /** Max assets (rows with ≥2 live locations) to examine in one pass. */
  batchSize?: number;
  /** When true, log intended moves but mutate nothing on disk or in the DB. */
  dryRun?: boolean;
}

/** One dedupe pass. Exported for tests + driven by `runDeDuplicatePass`. */
export async function runDeDuplicateOnce(
  opts: RunDeDuplicateOptions = {},
): Promise<DeDuplicateSummary> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const dryRun = opts.dryRun ?? false;

  let libs: ReadonlyMap<string, string>;
  try {
    libs = await loadLibraryRoots();
  } catch {
    libs = new Map();
  }

  const summary = emptySummary();

  // Live-aware gate: ≥2 live (non-tombstoned) locations, and not trashed. It is
  // a test on `live_location_count`, a column the `asset_locations` triggers
  // maintain — where Mongo needed a partial index on `fileinfo.1` to narrow to
  // multi-location rows and then an `$expr`/`$filter` pass to count each
  // candidate's non-tombstoned entries in memory (#1290). Settings → Workers
  // counts the badge on the same predicate, so the badge still reaches 0 from
  // this worker alone and no pass is spent on sticky non-live rows.
  //
  // NOTE: a duplicate set whose every on-disk copy is pinned by a `.keep` marker
  // stays a candidate here (and in the pending count) by design — `.keep` is
  // re-confirmed on disk per pass and the stored `keep` flag can go stale, so
  // there is no DB-side predicate that could safely exclude such rows without
  // risking permanently skipping a set whose marker was later removed. Each
  // pass processes them cheaply (stat the folders, `skippedAllKept`, return).
  const candidates = await listDuplicateCandidates(batchSize);

  for (const doc of candidates) {
    summary.scanned++;
    try {
      await processAsset(doc, libs, dryRun, summary);
    } catch (err) {
      summary.errors++;
      log.warn(
        { _id: String(doc._id), err: err instanceof Error ? err.message : err },
        'deduplicate: asset failed',
      );
    }
  }

  if (summary.scanned === 0) {
    // INFO so operators get a clear "nothing left to deduplicate" signal once
    // the live-aware backlog drains to 0. Logged on every idle pass; at the
    // 5-minute interval this produces at most ~288 lines/day, which is
    // acceptable. Promoted from debug (#1290).
    log.info('deduplicate pass: no live candidates — backlog is empty');
  } else {
    if (summary.skippedOffline > 0) {
      log.warn(
        { skippedOffline: summary.skippedOffline },
        'deduplicate: assets skipped because library root could not be resolved — ' +
          'check that all libraries are mounted and their paths in the folders collection match the filesystem',
      );
    }
    log.info(summary, 'deduplicate pass complete');
  }
  return summary;
}

/**
 * Collapse one asset's live duplicate locations down to the kept copy.
 *
 * An orchestrator over the phases in `dedupe.process-asset.ts` (#1988,
 * fallow CRITICAL complexity before this split): stat the live entries on
 * disk, validate + tag any absent ones, require ≥2 real on-disk copies
 * before touching anything, resolve which copies survive (`.keep` pins or
 * the `selectKeeper` ranking), relocate the rest into `_duplicates/`, then
 * drop the moved copies' location rows and publish the change. Each phase
 * function's own doc explains why it exists and what it guards against.
 */
async function processAsset(
  doc: DuplicateCandidate,
  libs: ReadonlyMap<string, string>,
  dryRun: boolean,
  summary: DeDuplicateSummary,
): Promise<void> {
  const liveEntries = doc.fileinfo.filter((e) => isLiveFileInfo(e));
  if (liveEntries.length < 2) return; // not a live duplicate set

  // Stat + validate + tag every live entry, bailing when fewer than two
  // copies are actually on disk right now — see `resolveOnDiskEntries`'s doc
  // for what each of the bundled phases guards against.
  const resolved = await resolveOnDiskEntries(doc._id, liveEntries, libs, dryRun);
  if ('skip' in resolved) {
    if (resolved.skip === 'offline') summary.skippedOffline++;
    else if (resolved.skip === 'missingFile') summary.skippedMissingFile++;
    return;
  }
  const { onDisk } = resolved;

  const { keepers, removeEntries } = await resolveKeepersAndRemovals(onDisk, libs);

  // Every on-disk copy is pinned by a `.keep` marker — nothing un-pinned to
  // collapse. Leave the asset exactly as it is (this is the whole point of the
  // marker: keep the duplicates).
  if (removeEntries.length === 0) {
    summary.skippedAllKept++;
    return;
  }

  const { primaryKeeper, keeperAbs, keeperKeys, anchorMoves } = resolveKeeperContext(
    doc,
    keepers,
    libs,
  );

  const moved = await moveEntriesToDuplicates(
    doc,
    removeEntries,
    libs,
    keeperKeys,
    dryRun,
    summary,
  );
  if (moved.length === 0) return; // nothing actually moved (all missing / errored)

  if (dryRun) {
    summary.dryRun++;
    return; // no database mutation in dry-run
  }

  await pullMovedEntriesFromFileinfo(doc._id, moved, anchorMoves);
  summary.deduped++;

  // Publish an update keyed by the surviving primary so clients + search refresh.
  await recordAndPublishAssetChange({
    kind: 'update',
    asset_id: doc._id,
    folder_id: primaryKeeper.library_id,
    abs_path: keeperAbs,
  });
}

const deduplicate = pausableWorker({
  name: DEDUPLICATE_NAME,
  log,
  unreadablePaused: true,
  defaultPaused: true,
  messages: {
    loadFailed: 'deduplicate: could not load persisted pause state — staying paused',
    paused: 'deduplicate paused',
    resumed: 'deduplicate RESUMED — duplicate originals will be moved into _duplicates/',
  },
  resumedLevel: 'warn',
});

/** Puts the worker on Settings → Workers. It is paused until an operator resumes it, because it relocates originals. */
export const registerDeDuplicate = (): RegisteredWorker => deduplicate.register();

/** The stored pause state; paused on first boot and whenever it can't be read. */
export const deDuplicatePaused = (): Promise<boolean> => deduplicate.readPaused();

/**
 * One scheduled pass. The schedule is paused along with the worker, but a run
 * already on its way when the operator pauses still finds it paused here.
 */
export async function runDeDuplicatePass(): Promise<void> {
  await deduplicate.runPass(async () => {
    if (await deduplicate.readPaused()) return { processed: 0 };
    const cfg = await loadDeDuplicateConfig();
    const summary = await runDeDuplicateOnce({ batchSize: cfg.batch_size, dryRun: cfg.dry_run });
    return { processed: summary.deduped };
  });
}
